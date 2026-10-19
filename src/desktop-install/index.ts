import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { type DesktopInstallationOwner, desktopBuildsMatch } from "../shared/desktop-installation-contract.js";
import {
	acquireDesktopMutation,
	desktopInstallationRoot,
	desktopStableAppPath,
	ensureDesktopPrivateDirectory,
	validateDesktopDirectoryAncestors,
} from "./admission.js";
import { inspectDesktopApp } from "./app-identity.js";
import { DesktopInstallationError } from "./errors.js";
import { desktopAppTreeSha256, desktopFileSha256, readDesktopJson, setDesktopTreeWritable } from "./files.js";
import { runDesktopInstallCommand, verifyDesktopDeveloperSignature } from "./macos.js";
import { validateDesktopReleaseManifest } from "./metadata.js";
import { downloadDesktopAsset } from "./network.js";
import { resolveDesktopInstallationOwner, sameDesktopOwner, validateDesktopInstallationOwner } from "./owner.js";
import { prepareDesktopInstallation } from "./prepare.js";
import {
	desktopVersionSchema,
	type ManagedDesktopInstallationReceipt,
	managedDesktopInstallationReceiptFilename,
	managedDesktopInstallationReceiptSchema,
} from "./receipt.js";
import { reapDesktopStages, writeDesktopStageOwner } from "./staging.js";
import {
	copyDesktopFileAtomic,
	desktopPathExists,
	syncDesktopDirectory,
	writeDesktopJson,
} from "./transaction-files.js";
import type {
	DesktopInstallation,
	DesktopInstallationArchitecture,
	DesktopInstallationDependencies,
	EnsureDesktopInstallationOptions,
} from "./types.js";

export type { DesktopInstallationOwner } from "../shared/desktop-installation-contract.js";
export { getDesktopAdmissionDescriptor, validateDesktopNativeAdmission } from "./admission.js";
export { DesktopInstallationError } from "./errors.js";
export type { ResolveDesktopInstallationOwnerOptions } from "./owner.js";
export { resolveDesktopInstallationOwner } from "./owner.js";
export type { DesktopInstallation, DesktopInstallationProgress, EnsureDesktopInstallationOptions } from "./types.js";

const journalSchema = z.strictObject({
	schemaVersion: z.literal(1),
	id: z.uuid(),
	stage: z.string(),
	oldReceipt: managedDesktopInstallationReceiptSchema.nullable(),
	oldAppPresent: z.boolean().optional(),
	newReceipt: managedDesktopInstallationReceiptSchema.nullable(),
	cleanupBackup: z.strictObject({ dev: z.number(), ino: z.number() }).nullable().optional(),
	cleanupStaged: z.strictObject({ dev: z.number(), ino: z.number() }).nullable().optional(),
	bootstrap: z
		.strictObject({ sha256: z.string().regex(/^[a-f0-9]{64}$/u), dev: z.number(), ino: z.number() })
		.optional(),
});
type Journal = z.infer<typeof journalSchema>;

export interface DesktopInstallationStatus {
	state: "missing" | "ready" | "incomplete" | "owner_conflict" | "changed";
	installation?: DesktopInstallation;
	message: string;
	pending: boolean;
}

function result(
	receipt: ManagedDesktopInstallationReceipt,
	receiptPath: string,
	cleanupPending = false,
): DesktopInstallation {
	return {
		appPath: receipt.appPath,
		version: receipt.version,
		arch: receipt.arch,
		source: receipt.source,
		installId: receipt.installId,
		buildId: receipt.buildId,
		appAsarSha256: receipt.appAsarSha256,
		receiptPath,
		owner: receipt.owner,
		cleanupPending,
	};
}

/** All mutation effects are confined to a fixed app and private metadata tree. Tests supply isolated paths. */
export function createDesktopInstallationService(dependencies: DesktopInstallationDependencies) {
	const root = resolve(dependencies.managedRoot);
	const appPath = resolve(dependencies.appPath ?? join(dirname(root), "Applications/Quarterdeck.app"));
	const receiptPath = join(root, managedDesktopInstallationReceiptFilename);
	const journalPath = join(root, "transaction.json");
	const lockPath = join(root, "admission.lock");
	const acquire = dependencies.acquireMutation ?? acquireDesktopMutation;

	async function readReceipt(): Promise<ManagedDesktopInstallationReceipt | null> {
		await validateDesktopDirectoryAncestors(root);
		if (!(await desktopPathExists(receiptPath))) return null;
		const parsed = managedDesktopInstallationReceiptSchema.safeParse(await readDesktopJson(receiptPath));
		if (!parsed.success || parsed.data.appPath !== appPath)
			throw new DesktopInstallationError(
				"installation_changed",
				"The managed installation receipt is invalid or names another app. No files were replaced.",
			);
		return parsed.data;
	}
	async function readJournal(): Promise<Journal | null> {
		await validateDesktopDirectoryAncestors(root);
		if (!(await desktopPathExists(journalPath))) return null;
		const parsed = journalSchema.safeParse(await readDesktopJson(journalPath));
		if (
			!parsed.success ||
			parsed.data.stage !== join(dirname(appPath), `.Quarterdeck-install-${parsed.data.id}`) ||
			[parsed.data.oldReceipt, parsed.data.newReceipt].some((receipt) => receipt && receipt.appPath !== appPath)
		)
			throw new DesktopInstallationError(
				"incomplete_installation",
				"The pending installation journal cannot be verified. No files were changed.",
			);
		await validateDesktopDirectoryAncestors(parsed.data.stage);
		const stage = await lstat(parsed.data.stage);
		if (!stage.isDirectory() || stage.isSymbolicLink() || stage.uid !== process.getuid?.() || stage.mode & 0o077)
			throw new DesktopInstallationError(
				"incomplete_installation",
				"The pending installation stage is not a real private directory. No files were changed.",
			);
		return parsed.data;
	}
	async function matches(path: string, receipt: ManagedDesktopInstallationReceipt | null): Promise<boolean> {
		if (!receipt || !(await desktopPathExists(path))) return false;
		const info = await lstat(path);
		return (
			info.isDirectory() && !info.isSymbolicLink() && (await desktopAppTreeSha256(path)) === receipt.appTreeSha256
		);
	}
	async function removeAuthorized(
		journal: Journal,
		path: string,
		receipt: ManagedDesktopInstallationReceipt,
		field: "cleanupBackup" | "cleanupStaged",
	): Promise<void> {
		if (await desktopPathExists(path)) {
			const info = await lstat(path);
			const authorization = journal[field];
			if (authorization) {
				if (
					!info.isDirectory() ||
					info.isSymbolicLink() ||
					info.dev !== authorization.dev ||
					info.ino !== authorization.ino
				)
					throw new DesktopInstallationError(
						"installation_changed",
						"The backup directory changed during cleanup; it was retained.",
					);
			} else {
				if (!(await matches(path, receipt)))
					throw new DesktopInstallationError(
						"installation_changed",
						"An owned app changed before cleanup; it was retained.",
					);
				journal[field] = { dev: info.dev, ino: info.ino };
				await writeDesktopJson(journalPath, journal);
				await dependencies.checkpoint?.("cleanup_authorized");
			}
			await setDesktopTreeWritable(path, true);
			await rm(path, { recursive: true });
		}
	}
	async function storeBootstrap(stage: string, source: string): Promise<NonNullable<Journal["bootstrap"]>> {
		const path = join(stage, "mutation-bootstrap");
		await copyDesktopFileAtomic(source, path);
		await chmod(path, 0o700);
		const info = await lstat(path);
		return { sha256: await desktopFileSha256(path), dev: info.dev, ino: info.ino };
	}
	async function allocateStage(id: string, owner: DesktopInstallationOwner): Promise<string> {
		const stage = join(dirname(appPath), `.Quarterdeck-install-${id}`);
		const allocation = join(root, `.allocate-${id}`);
		await mkdir(allocation, { mode: 0o700 });
		try {
			await writeDesktopStageOwner(allocation, id, appPath, owner, dependencies.stageIdentity);
			await rename(allocation, stage);
			await syncDesktopDirectory(dirname(appPath));
		} finally {
			await rm(allocation, { recursive: true, force: true });
		}
		return stage;
	}
	async function verifyRetainedManifest(path: string, receipt: ManagedDesktopInstallationReceipt): Promise<void> {
		if (!receipt.release) throw new DesktopInstallationError("invalid_artifact", "No release manifest was expected.");
		// readDesktopJson refuses symbolic links and bounds the file before hashing or copying it.
		const manifest = validateDesktopReleaseManifest(await readDesktopJson(path), receipt.version, receipt.arch);
		if (
			(await desktopFileSha256(path)) !== receipt.release.manifestSha256 ||
			manifest.sourceSha !== receipt.release.sourceSha ||
			manifest.expectedTeamId !== receipt.signing.teamId
		)
			throw new DesktopInstallationError(
				"incomplete_installation",
				"The expected release manifest is missing or changed. Recovery retained the installation journal.",
			);
	}
	async function restoreManifest(receipt: ManagedDesktopInstallationReceipt, candidate: string): Promise<void> {
		const retained = join(root, "release-manifest.json");
		if (!receipt.release) {
			await rm(retained, { force: true });
			await syncDesktopDirectory(root);
			return;
		}
		if (await desktopPathExists(candidate)) {
			await verifyRetainedManifest(candidate, receipt);
			await copyDesktopFileAtomic(candidate, retained);
		} else {
			await verifyRetainedManifest(retained, receipt);
		}
	}
	async function journalBootstrap(journal: Journal): Promise<string> {
		const path = join(journal.stage, "mutation-bootstrap");
		const directory = await lstat(journal.stage);
		const info = await lstat(path);
		if (
			!journal.bootstrap ||
			!directory.isDirectory() ||
			directory.isSymbolicLink() ||
			directory.uid !== process.getuid?.() ||
			directory.mode & 0o077 ||
			!info.isFile() ||
			info.isSymbolicLink() ||
			info.dev !== journal.bootstrap.dev ||
			info.ino !== journal.bootstrap.ino ||
			(await desktopFileSha256(path)) !== journal.bootstrap.sha256
		)
			throw new DesktopInstallationError(
				"incomplete_installation",
				"The interrupted transaction's native admission helper cannot be verified. Retry desktop install with a matching --from app.",
			);
		return path;
	}
	async function cleanup(journal: Journal): Promise<void> {
		if (journal.oldReceipt)
			await removeAuthorized(journal, join(journal.stage, "backup.app"), journal.oldReceipt, "cleanupBackup");
		if (journal.newReceipt)
			await removeAuthorized(journal, join(journal.stage, "Quarterdeck.app"), journal.newReceipt, "cleanupStaged");
		if (
			(await desktopPathExists(join(journal.stage, "mount"))) &&
			(await lstat(join(journal.stage, "mount"))).dev !== (await lstat(journal.stage)).dev
		)
			throw new DesktopInstallationError(
				"incomplete_installation",
				"A private installation mount remains attached; staging was retained.",
			);
		// Keep the verified helper available until the journal is durably gone. An orphan stage is reapable.
		await rm(journalPath, { force: true });
		await syncDesktopDirectory(root);
		await rm(journal.stage, { recursive: true, force: true });
	}
	async function recoverPending(): Promise<void> {
		const journal = await readJournal();
		if (!journal) return;
		const backup = join(journal.stage, "backup.app");
		if (!journal.newReceipt && !(await desktopPathExists(appPath)) && !(await desktopPathExists(receiptPath))) {
			// Receipt removal commits uninstall. Its cleanup may have removed any amount of the backup.
			await rm(join(root, "release-manifest.json"), { force: true });
		} else if (journal.newReceipt && (await matches(appPath, journal.newReceipt))) {
			await restoreManifest(journal.newReceipt, join(journal.stage, "release-manifest.json"));
			await writeDesktopJson(receiptPath, journal.newReceipt);
		} else if (journal.oldReceipt && (await matches(appPath, journal.oldReceipt))) {
			await restoreManifest(journal.oldReceipt, join(journal.stage, "previous-release-manifest.json"));
			await writeDesktopJson(receiptPath, journal.oldReceipt);
		} else if (
			!(await desktopPathExists(appPath)) &&
			journal.oldReceipt &&
			(await matches(backup, journal.oldReceipt))
		) {
			// An uninstall commits only once its receipt has been durably removed.
			if (journal.newReceipt || (await desktopPathExists(receiptPath))) {
				await rename(backup, appPath);
				await syncDesktopDirectory(dirname(appPath));
				await writeDesktopJson(receiptPath, journal.oldReceipt);
				await restoreManifest(journal.oldReceipt, join(journal.stage, "previous-release-manifest.json"));
			}
		} else if (!(await desktopPathExists(appPath)) && journal.oldReceipt && journal.oldAppPresent === false) {
			await restoreManifest(journal.oldReceipt, join(journal.stage, "previous-release-manifest.json"));
			await writeDesktopJson(receiptPath, journal.oldReceipt);
		} else if (!(await desktopPathExists(appPath)) && !journal.oldReceipt) {
			await rm(receiptPath, { force: true });
		} else
			throw new DesktopInstallationError(
				"incomplete_installation",
				"The interrupted installation contains an unrecognized app. Recovery retained every candidate; repair or inspect it before retrying.",
			);
		await cleanup(journal);
	}
	async function validate(
		options: { owner?: DesktopInstallationOwner; version?: string; appPath?: string } = {},
	): Promise<DesktopInstallation> {
		if (await desktopPathExists(journalPath))
			throw new DesktopInstallationError(
				"incomplete_installation",
				"An installation was interrupted. Quit Quarterdeck, then run quarterdeck desktop install to finish recovery.",
			);
		const receipt = await readReceipt();
		if (!receipt)
			throw new DesktopInstallationError(
				"incomplete_installation",
				"The npm-managed app is missing. Run quarterdeck desktop install.",
			);
		if (options.appPath && resolve(options.appPath) !== appPath)
			throw new DesktopInstallationError(
				"installation_changed",
				"Open the npm-managed Quarterdeck app in ~/Applications.",
			);
		if (options.version && options.version !== receipt.version)
			throw new DesktopInstallationError(
				"installation_changed",
				"The app and npm CLI versions differ. Quit Quarterdeck and run quarterdeck desktop install.",
			);
		if (options.owner && !sameDesktopOwner(options.owner, receipt.owner))
			throw new DesktopInstallationError(
				"owner_conflict",
				"Another npm prefix owns Quarterdeck. Run quarterdeck desktop install --replace-owner to explicitly transfer ownership.",
			);
		await validateDesktopInstallationOwner(receipt.owner);
		const appInfo = await lstat(appPath);
		if (!appInfo.isDirectory() || appInfo.isSymbolicLink())
			throw new DesktopInstallationError(
				"installation_changed",
				"The managed app was replaced by a symbolic link or non-directory.",
			);
		const identity = await inspectDesktopApp(appPath, receipt.version, receipt.arch, dependencies);
		if (
			identity.appTreeSha256 !== receipt.appTreeSha256 ||
			identity.appAsarSha256 !== receipt.appAsarSha256 ||
			identity.bundle.buildId !== receipt.buildId ||
			!desktopBuildsMatch(receipt.owner, identity.bundle, receipt.source)
		)
			throw new DesktopInstallationError(
				"installation_changed",
				"The app and recorded npm build no longer form a verified pair. Quit Quarterdeck and repair the npm installation.",
			);
		if (receipt.release) {
			const manifestPath = join(root, "release-manifest.json");
			await verifyRetainedManifest(manifestPath, receipt);
		}
		if (receipt.signing.verified && receipt.signing.teamId)
			await verifyDesktopDeveloperSignature(appPath, receipt.signing.teamId, dependencies.runCommand);
		return result(receipt, receiptPath);
	}
	async function status(options: { owner?: DesktopInstallationOwner } = {}): Promise<DesktopInstallationStatus> {
		const pending = await desktopPathExists(journalPath);
		try {
			if (!(await desktopPathExists(receiptPath)) && !(await desktopPathExists(appPath)) && !pending)
				return { state: "missing", message: "The managed macOS app is not installed.", pending: false };
			const installation = await validate(options);
			return { state: "ready", installation, message: "The npm CLI and macOS app are a verified pair.", pending };
		} catch (error) {
			return {
				state:
					error instanceof DesktopInstallationError && error.code === "owner_conflict"
						? "owner_conflict"
						: pending
							? "incomplete"
							: "changed",
				message: error instanceof Error ? error.message : "The installation could not be verified.",
				pending,
			};
		}
	}
	async function ensure(options: EnsureDesktopInstallationOptions): Promise<DesktopInstallation> {
		if (dependencies.platform !== "darwin" || !["arm64", "x64"].includes(dependencies.arch))
			throw new DesktopInstallationError(
				"unsupported_platform",
				"The macOS app requires native macOS arm64 or x64. Browser mode remains available.",
			);
		if (dependencies.arch === "x64") {
			let translated = false;
			try {
				translated =
					(await dependencies.runCommand("/usr/sbin/sysctl", ["-in", "sysctl.proc_translated"])).stdout.trim() ===
					"1";
			} catch {
				/* Intel macOS has no translation key. */
			}
			if (translated)
				throw new DesktopInstallationError(
					"unsupported_platform",
					"Use native arm64 Node on this Apple Silicon Mac, then rerun npm install or npm run link.",
				);
		}
		if (!desktopVersionSchema.safeParse(options.version).success)
			throw new DesktopInstallationError("invalid_version", "Desktop installation requires an exact npm version.");
		if (options.from === "")
			throw new DesktopInstallationError("invalid_artifact", "The --from option requires an explicit .app path.");
		const owner = options.owner ?? dependencies.owner ?? (await resolveDesktopInstallationOwner());
		if (owner.identity.version !== options.version)
			throw new DesktopInstallationError(
				"invalid_version",
				"The requested app version differs from its owning CLI.",
			);
		await validateDesktopInstallationOwner(owner);
		await ensureDesktopPrivateDirectory(root);
		await validateDesktopDirectoryAncestors(dirname(appPath));
		await mkdir(dirname(appPath), { recursive: true, mode: 0o755 });
		const parentInfo = await lstat(dirname(appPath));
		if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.uid !== process.getuid?.())
			throw new DesktopInstallationError(
				"installation_changed",
				"The Applications directory must be a real user-owned directory.",
			);
		if (!options.from && !(await desktopPathExists(journalPath))) {
			const current = await status({ owner });
			if (current.state === "ready" && current.installation?.version === options.version)
				return current.installation;
		}
		const stagedCount = (await readdir(dirname(appPath))).filter((name) =>
			/^\.Quarterdeck-install-[a-f0-9-]{36}$/u.test(name),
		).length;
		if (stagedCount >= 4) {
			const pending = await readJournal();
			const existing = await readReceipt();
			let bootstrap: string | undefined;
			if (pending?.bootstrap) bootstrap = await journalBootstrap(pending);
			else if (existing && (await matches(appPath, existing)))
				bootstrap = join(appPath, "Contents/Resources/runtime/installation-admission");
			else if (options.from) {
				const source = await inspectDesktopApp(
					resolve(options.from),
					options.version,
					dependencies.arch as DesktopInstallationArchitecture,
					dependencies,
				);
				if (desktopBuildsMatch(owner, source.bundle, "local"))
					bootstrap = join(source.appPath, "Contents/Resources/runtime/installation-admission");
			}
			if (bootstrap) {
				const release = await acquire(bootstrap, lockPath);
				try {
					await recoverPending();
					await reapDesktopStages(appPath, null);
				} finally {
					await release();
				}
			}
		}
		if (
			(await readdir(dirname(appPath))).filter((name) => /^\.Quarterdeck-install-[a-f0-9-]{36}$/u.test(name))
				.length >= 4
		)
			throw new DesktopInstallationError(
				"incomplete_installation",
				"Four private installer stages remain. Resolve interrupted installation staging before preparing another download.",
			);
		const id = randomUUID();
		const stage = await allocateStage(id, owner);
		let ownsJournal = false;
		let committed = false;
		let promoted = false;
		let journal: Journal | undefined;
		let releaseLock: (() => Promise<void>) | undefined;
		try {
			const prepared = await prepareDesktopInstallation(
				stage,
				appPath,
				owner,
				options,
				dependencies.arch as DesktopInstallationArchitecture,
				dependencies,
			);
			releaseLock = await acquire(prepared.bootstrap, lockPath);
			await recoverPending();
			await reapDesktopStages(appPath, stage);
			const oldReceipt = await readReceipt();
			const oldAppPresent = await desktopPathExists(appPath);
			if (oldReceipt && !sameDesktopOwner(oldReceipt.owner, owner) && !options.replaceOwner)
				throw new DesktopInstallationError(
					"owner_conflict",
					"A different npm package slot owns Quarterdeck. Use --replace-owner to transfer it explicitly.",
				);
			if (oldReceipt && oldAppPresent && !(await matches(appPath, oldReceipt)))
				throw new DesktopInstallationError(
					"installation_changed",
					"The current app changed. It was retained; inspect the installation before replacement.",
				);
			if (!oldReceipt && (await desktopPathExists(appPath)))
				throw new DesktopInstallationError(
					"installation_changed",
					"An unmanaged app occupies ~/Applications/Quarterdeck.app. Move it aside explicitly before installing.",
				);
			await validateDesktopInstallationOwner(owner);
			journal = {
				schemaVersion: 1,
				id,
				stage,
				oldReceipt,
				oldAppPresent,
				newReceipt: prepared.receipt,
				bootstrap: await storeBootstrap(stage, prepared.bootstrap),
			};
			if (oldReceipt?.release) {
				await verifyRetainedManifest(join(root, "release-manifest.json"), oldReceipt);
				await copyDesktopFileAtomic(
					join(root, "release-manifest.json"),
					join(stage, "previous-release-manifest.json"),
				);
			}
			await writeDesktopJson(journalPath, journal);
			ownsJournal = true;
			if (oldReceipt && oldAppPresent) await rename(appPath, join(stage, "backup.app"));
			await syncDesktopDirectory(dirname(appPath));
			await dependencies.checkpoint?.("backed_up");
			await rename(prepared.stagedApp, appPath);
			promoted = true;
			await syncDesktopDirectory(dirname(appPath));
			await dependencies.checkpoint?.("promoted");
			await restoreManifest(prepared.receipt, join(stage, "release-manifest.json"));
			await dependencies.checkpoint?.("metadata_written");
			await writeDesktopJson(receiptPath, prepared.receipt);
			committed = true;
			let cleanupPending = false;
			try {
				await dependencies.checkpoint?.("receipt_committed");
				await cleanup(journal);
			} catch {
				cleanupPending = true;
			}
			try {
				options.onProgress?.({
					phase: "installed",
					message: "The npm CLI and macOS app are installed as one pair.",
				});
			} catch {
				/* Commit already completed. */
			}
			return result(prepared.receipt, receiptPath, cleanupPending);
		} catch (error) {
			if (ownsJournal && journal && !committed) {
				try {
					// Live failures before the receipt commit roll back; crash recovery instead adopts an exact promoted pair.
					if (promoted && journal.newReceipt && (await matches(appPath, journal.newReceipt)))
						await rename(appPath, join(stage, "Quarterdeck.app"));
					const backup = join(stage, "backup.app");
					if (journal.oldReceipt && (await matches(backup, journal.oldReceipt))) await rename(backup, appPath);
					await syncDesktopDirectory(dirname(appPath));
					if (journal.oldReceipt) await writeDesktopJson(receiptPath, journal.oldReceipt);
					else await rm(receiptPath, { force: true });
					if (journal.oldReceipt)
						await restoreManifest(journal.oldReceipt, join(stage, "previous-release-manifest.json"));
					else await rm(join(root, "release-manifest.json"), { force: true });
					await cleanup(journal);
				} catch {
					/* Preserve exact recovery candidates and original failure. */
				}
			}
			throw error;
		} finally {
			await releaseLock?.();
			if (!ownsJournal && !(await desktopPathExists(join(stage, "retain-mounted-stage.json"))))
				await rm(stage, { recursive: true, force: true });
		}
	}
	async function uninstall(
		options: { owner?: DesktopInstallationOwner; replaceOwner?: boolean } = {},
	): Promise<{ removed: boolean; message: string; cleanupPending?: boolean }> {
		const pending = await readJournal();
		if (pending) {
			const pendingOwner = pending.newReceipt?.owner ?? pending.oldReceipt?.owner;
			const invokingOwner = options.owner ?? dependencies.owner ?? (await resolveDesktopInstallationOwner());
			if (pendingOwner && !sameDesktopOwner(invokingOwner, pendingOwner) && !options.replaceOwner)
				throw new DesktopInstallationError(
					"owner_conflict",
					"Another npm prefix owns the interrupted transaction; use --replace-owner for an explicit uninstall.",
				);
			const release = await acquire(await journalBootstrap(pending), lockPath);
			try {
				await recoverPending();
			} finally {
				await release();
			}
		}
		const receipt = await readReceipt();
		if (!receipt) return { removed: false, message: "No managed macOS app is installed." };
		const owner = options.owner ?? dependencies.owner ?? (await resolveDesktopInstallationOwner());
		if (!sameDesktopOwner(owner, receipt.owner) && !options.replaceOwner)
			throw new DesktopInstallationError(
				"owner_conflict",
				"Another npm prefix owns this app; use --replace-owner for an explicit uninstall.",
			);
		if (!(await matches(appPath, receipt)))
			throw new DesktopInstallationError(
				"installation_changed",
				"The app changed and was retained. No user state was removed.",
			);
		const release = await acquire(join(appPath, "Contents/Resources/runtime/installation-admission"), lockPath);
		try {
			await recoverPending();
			const current = await readReceipt();
			if (!current || current.installId !== receipt.installId || !(await matches(appPath, current)))
				throw new DesktopInstallationError(
					"installation_changed",
					"The installation changed while uninstall was being admitted.",
				);
			const id = randomUUID();
			const stage = await allocateStage(id, owner);
			const journal: Journal = {
				schemaVersion: 1,
				id,
				stage,
				oldReceipt: current,
				newReceipt: null,
				bootstrap: await storeBootstrap(stage, join(appPath, "Contents/Resources/runtime/installation-admission")),
			};
			if (current.release) {
				await verifyRetainedManifest(join(root, "release-manifest.json"), current);
				await copyDesktopFileAtomic(
					join(root, "release-manifest.json"),
					join(stage, "previous-release-manifest.json"),
				);
			}
			await writeDesktopJson(journalPath, journal);
			await rename(appPath, join(stage, "backup.app"));
			await syncDesktopDirectory(dirname(appPath));
			await rm(receiptPath);
			await syncDesktopDirectory(root);
			await rm(join(root, "release-manifest.json"), { force: true });
			try {
				await cleanup(journal);
			} catch {
				return {
					removed: true,
					cleanupPending: true,
					message:
						"The managed app was removed. Temporary cleanup remains; run quarterdeck desktop uninstall again to finish. User state was preserved.",
				};
			}
			return {
				removed: true,
				message: "The managed app was removed. Projects, settings, and runtime state were preserved.",
			};
		} finally {
			await release();
		}
	}
	return {
		ensureDesktopInstallation: ensure,
		validateDesktopInstallation: validate,
		getDesktopInstallationStatus: status,
		uninstallDesktopInstallation: uninstall,
	};
}

function productionService() {
	const user = userInfo();
	if (
		user.uid === 0 ||
		process.env.SUDO_UID ||
		process.env.SUDO_USER ||
		(process.env.HOME !== undefined && resolve(process.env.HOME) !== resolve(user.homedir))
	)
		throw new DesktopInstallationError(
			"unsupported_platform",
			"Desktop installation requires your own macOS login home and a user-owned npm prefix. Run it without sudo or a HOME override.",
		);
	return createDesktopInstallationService({
		platform: process.platform,
		arch: process.arch,
		managedRoot: desktopInstallationRoot(),
		appPath: desktopStableAppPath(),
		runCommand: runDesktopInstallCommand,
		download: downloadDesktopAsset,
	});
}
export function ensureDesktopInstallation(options: EnsureDesktopInstallationOptions) {
	return productionService().ensureDesktopInstallation(options);
}
export function validateDesktopInstallation(
	options: { owner?: DesktopInstallationOwner; version?: string; appPath?: string } = {},
) {
	return productionService().validateDesktopInstallation(options);
}
export function getDesktopInstallationStatus(options: { owner?: DesktopInstallationOwner } = {}) {
	return productionService().getDesktopInstallationStatus(options);
}
export function uninstallDesktopInstallation(
	options: { owner?: DesktopInstallationOwner; replaceOwner?: boolean } = {},
) {
	return productionService().uninstallDesktopInstallation(options);
}
