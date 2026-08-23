import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type Dirent } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import {
	type DiagnosticBundleContentFlags,
	type DiagnosticBundleManifest,
	type DiagnosticFinding,
	type DiagnosticProviderResult,
	type DiagnosticRecordEnvelope,
	type DiagnosticRecorderHealth,
	type DiagnosticSnapshot,
	normalizeDiagnosticErrorClass,
	type PublicRuntimeDiagnosticDescriptor,
} from "../core";
import { getDiagnosticBundlesRootPath } from "./runtime-instance";

export interface WriteDiagnosticBundleOptions {
	quarterdeckVersion: string;
	descriptor: PublicRuntimeDiagnosticDescriptor;
	records: readonly DiagnosticRecordEnvelope[];
	snapshot: DiagnosticSnapshot;
	findings: readonly DiagnosticFinding[];
	health: DiagnosticRecorderHealth | null;
	warnings?: readonly string[];
	projectId?: string | null;
	taskId?: string | null;
	tier?: "flight" | "deep" | "agent-lab";
	contentFlags?: Partial<DiagnosticBundleContentFlags>;
	outputDirectory?: string;
	stateHome?: string;
	additionalEvidence?: readonly DiagnosticBundleEvidenceSource[];
}

export interface DiagnosticBundleEvidenceSource {
	sourcePath: string;
	bundlePath: string;
	required?: boolean;
}

export interface WriteDiagnosticBundleResult {
	path: string;
	manifest: DiagnosticBundleManifest;
}

const DEFAULT_CONTENT_FLAGS: DiagnosticBundleContentFlags = {
	includePaths: false,
	includeTaskText: false,
	includeTerminal: false,
	includeGitDiff: false,
};

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function writePrivateText(path: string, contents: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
	await writePrivateText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function safeName(value: string): string {
	return (
		value
			.replace(/[^A-Za-z0-9._-]+/gu, "-")
			.replace(/^-+|-+$/gu, "")
			.slice(0, 80) || "unknown"
	);
}

function defaultBundleDirectory(options: WriteDiagnosticBundleOptions): string {
	const timestamp = new Date()
		.toISOString()
		.replace(/[-:]/gu, "")
		.replace(/\.\d{3}Z$/u, "Z");
	return join(
		getDiagnosticBundlesRootPath(options.stateHome),
		`quarterdeck-diagnostics-${timestamp}-${safeName(options.descriptor.runtimeInstanceId).slice(0, 8)}`,
	);
}

function providerFile(provider: DiagnosticProviderResult): string {
	if (provider.name === "runtime") return "runtime/snapshot.json";
	if (provider.name === "browser") return "browser/clients.json";
	if (provider.name === "projects") return "projects/snapshot.json";
	return `runtime/providers/${safeName(provider.name)}.json`;
}

function countBy<T>(values: readonly T[], key: (value: T) => string): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const value of values) {
		const name = key(value);
		counts[name] = (counts[name] ?? 0) + 1;
	}
	return counts;
}

function generatedReadme(
	options: WriteDiagnosticBundleOptions,
	warnings: readonly string[],
	tier: NonNullable<WriteDiagnosticBundleOptions["tier"]>,
): string {
	return `# Quarterdeck diagnostic bundle

This local bundle was created by Quarterdeck and was not uploaded automatically.

Start with \`manifest.json\`. Records in \`records.jsonl\` are ordered by \`sequence\` within runtime instance \`${options.descriptor.runtimeInstanceId}\`. Use the context identifiers on each record to correlate task, session instance, connection, delivery, request, and operation lifecycles.

Redaction profile: \`quarterdeck-default-v1\`. Default capture excludes prompts, terminal text, file contents, diffs, environment values, command arguments, request bodies, DOM text, and secrets. See \`manifest.json\` for the exact content flags used.

Provider limitations: ${warnings.length > 0 ? warnings.join("; ") : "none reported"}.
${tier === "agent-lab" ? "\nSynthetic lab evidence is indexed in `manifest.json` and stored under `lab/`.\n" : ""}
`;
}

function resolveEvidenceDestination(root: string, requestedPath: string): string {
	const normalized = requestedPath.replaceAll("\\", "/").replace(/^\.\//u, "");
	const segments = normalized.split("/");
	if (
		!normalized ||
		normalized.startsWith("/") ||
		/^[A-Za-z]:/u.test(normalized) ||
		segments.some((segment) => segment === "" || segment === "." || segment === "..")
	) {
		throw new Error(`Invalid diagnostic evidence destination: ${requestedPath}`);
	}
	if (segments[0] !== "lab") {
		throw new Error(`Diagnostic evidence must be stored under lab/: ${requestedPath}`);
	}
	const destination = resolve(root, ...segments);
	if (!destination.startsWith(`${resolve(root)}/`) && !destination.startsWith(`${resolve(root)}\\`)) {
		throw new Error(`Diagnostic evidence destination escaped bundle root: ${requestedPath}`);
	}
	return destination;
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

async function copyEvidencePath(source: string, destination: string): Promise<void> {
	const info = await lstat(source);
	if (info.isSymbolicLink()) throw new Error("Symbolic links are not supported in diagnostic evidence.");
	if (info.isFile()) {
		await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
		await copyFile(source, destination);
		await chmod(destination, 0o600).catch(() => undefined);
		return;
	}
	if (!info.isDirectory()) throw new Error("Only regular files and directories are supported as diagnostic evidence.");
	await mkdir(destination, { recursive: true, mode: 0o700 });
	const entries = await readdir(source, { withFileTypes: true });
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (entry.isSymbolicLink()) continue;
		await copyEvidencePath(join(source, entry.name), join(destination, entry.name));
	}
}

async function collectFiles(
	root: string,
	current = root,
): Promise<Array<{ path: string; size: number; sha256: string }>> {
	let entries: Dirent[];
	try {
		entries = await readdir(current, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: Array<{ path: string; size: number; sha256: string }> = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		const path = join(current, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectFiles(root, path)));
			continue;
		}
		if (!entry.isFile() || entry.name === "manifest.json") continue;
		const [sha256, info] = await Promise.all([hashFile(path), stat(path)]);
		files.push({
			path: relative(root, path).replaceAll("\\", "/"),
			size: info.size,
			sha256,
		});
	}
	return files;
}

export async function writeDiagnosticBundle(
	options: WriteDiagnosticBundleOptions,
): Promise<WriteDiagnosticBundleResult> {
	const tier = options.tier ?? (options.health?.recording.active ? "deep" : "flight");
	if ((options.additionalEvidence?.length ?? 0) > 0 && tier !== "agent-lab") {
		throw new Error("Additional diagnostic evidence is restricted to the isolated agent-lab tier.");
	}
	const contentFlags = { ...DEFAULT_CONTENT_FLAGS, ...options.contentFlags };
	if (tier !== "agent-lab" && Object.values(contentFlags).some(Boolean)) {
		throw new Error("Content-bearing diagnostic flags are restricted to the isolated agent-lab tier.");
	}
	const destination = resolve(options.outputDirectory ?? defaultBundleDirectory(options));
	if (await pathExists(destination)) throw new Error(`Diagnostic bundle output already exists: ${destination}`);
	await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
	const temporary = join(dirname(destination), `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
	await mkdir(temporary, { recursive: true, mode: 0o700 });

	const warnings = Array.from(
		new Set([
			...(options.warnings ?? []),
			...options.snapshot.providers
				.filter((provider) => provider.status !== "completed")
				.map((provider) => `${provider.name}: ${provider.error ?? provider.status}`),
		]),
	);
	const records = [...options.records].sort((left, right) => left.sequence - right.sequence);

	try {
		for (const evidence of options.additionalEvidence ?? []) {
			const destinationPath = resolveEvidenceDestination(temporary, evidence.bundlePath);
			try {
				await copyEvidencePath(resolve(evidence.sourcePath), destinationPath);
			} catch (error) {
				const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
				if (!missing || evidence.required) {
					const errorClass = error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError";
					warnings.push(`${evidence.bundlePath}: evidence unavailable (${errorClass})`);
				}
			}
		}
		await Promise.all([
			writePrivateText(join(temporary, "README.md"), generatedReadme(options, warnings, tier)),
			writePrivateText(
				join(temporary, "records.jsonl"),
				records.length > 0 ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "",
			),
			writePrivateJson(join(temporary, "doctor.json"), options.findings),
			writePrivateJson(join(temporary, "runtime", "descriptor.json"), options.descriptor),
			writePrivateJson(join(temporary, "runtime", "recorder-health.json"), options.health),
			...options.snapshot.providers.map(async (provider) => {
				await writePrivateJson(join(temporary, providerFile(provider)), provider);
			}),
		]);

		const files = await collectFiles(temporary);
		const manifest: DiagnosticBundleManifest = {
			version: 1,
			bundleId: randomUUID(),
			quarterdeckVersion: options.quarterdeckVersion,
			runtimeInstanceId: options.descriptor.runtimeInstanceId,
			createdAt: new Date().toISOString(),
			tier,
			status: warnings.length > 0 ? "partial" : "complete",
			timeRange: {
				from: records[0]?.timestamp ?? null,
				to: records.at(-1)?.timestamp ?? null,
			},
			filters: {
				projectId: options.projectId ?? null,
				taskId: options.taskId ?? null,
			},
			redactionProfile: "quarterdeck-default-v1",
			contentFlags,
			providerResults: options.snapshot.providers,
			recordCounts: countBy(records, (record) => `${record.source}.${record.kind}.${record.level}`),
			findingCounts: countBy(options.findings, (finding) => finding.severity),
			warnings,
			files,
		};
		await writePrivateJson(join(temporary, "manifest.json"), manifest);
		try {
			await rename(temporary, destination);
			return { path: destination, manifest };
		} catch (error) {
			const errorClass = error instanceof Error ? normalizeDiagnosticErrorClass(error.name) : "UnknownError";
			const partialManifest: DiagnosticBundleManifest = {
				...manifest,
				status: "partial",
				warnings: [
					...manifest.warnings,
					`Bundle finalization failed (${errorClass}); evidence remains at the temporary path.`,
				],
			};
			await writePrivateJson(join(temporary, "manifest.json"), partialManifest);
			return { path: temporary, manifest: partialManifest };
		}
	} catch (error) {
		await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}
