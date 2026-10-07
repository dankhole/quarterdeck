import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

const identitySchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const MAX_RECEIPT_BYTES = 2_048;

export const FakeInvocationReceiptSchema = z
	.strictObject({
		version: z.literal(1),
		provider: z.literal("codex"),
		taskId: identitySchema,
		sessionInstanceId: identitySchema,
		pid: z.number().int().positive(),
		providerSessionId: identitySchema,
		resumeKind: z.enum(["fresh", "continue", "targeted"]),
		requestedSessionId: identitySchema.nullable(),
		historyPresent: z.boolean(),
	})
	.superRefine((receipt, context) => {
		if ((receipt.resumeKind === "targeted") !== (receipt.requestedSessionId !== null)) {
			context.addIssue({ code: "custom", message: "Resume kind and requested identity must agree." });
		}
		if (receipt.requestedSessionId !== null && receipt.requestedSessionId !== receipt.providerSessionId) {
			context.addIssue({ code: "custom", message: "Targeted provider identity must match the requested identity." });
		}
	});

export type FakeInvocationReceipt = z.infer<typeof FakeInvocationReceiptSchema>;

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function assertContained(root: string, path: string): void {
	const child = relative(root, path);
	if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
		throw new Error("Fake invocation evidence must remain inside its isolated fixture.");
	}
}

async function assertNoSymlinkParents(root: string, path: string): Promise<void> {
	assertContained(root, path);
	let current = root;
	for (const segment of relative(root, path).split(sep)) {
		current = join(current, segment);
		try {
			if ((await lstat(current)).isSymbolicLink())
				throw new Error("Fake invocation evidence cannot follow symlinks.");
		} catch (error) {
			if (isMissing(error)) return;
			throw error;
		}
	}
}

/** Require the explicitly isolated lab environment; never fall back to the user's profile. */
export async function resolveFakeCodexHistoryPath(environment: NodeJS.ProcessEnv, sessionId: string): Promise<string> {
	identitySchema.parse(sessionId);
	const tempRoot = environment.TMPDIR || environment.TEMP;
	const home = environment.HOME || environment.USERPROFILE;
	const stateHome = environment.QUARTERDECK_STATE_HOME;
	if (
		environment.QUARTERDECK_AGENT_LAB !== "1" ||
		!tempRoot ||
		!home ||
		!stateHome ||
		!isAbsolute(tempRoot) ||
		!isAbsolute(home) ||
		!isAbsolute(stateHome)
	) {
		throw new Error("Fake Codex history requires an explicit isolated Agent Lab environment.");
	}
	const canonicalRoot = await realpath(tempRoot);
	const canonicalHome = await realpath(home);
	assertContained(canonicalRoot, canonicalHome);
	assertContained(canonicalRoot, await realpath(stateHome));
	let codexHome = join(canonicalHome, ".codex");
	if (environment.CODEX_HOME) {
		const suppliedPath = resolve(environment.CODEX_HOME);
		const relativeToHome = relative(resolve(home), suppliedPath);
		const usesHomeAlias =
			relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome);
		codexHome = usesHomeAlias ? resolve(canonicalHome, relativeToHome) : suppliedPath;
	}
	const path = join(codexHome, "sessions", `rollout-${sessionId}.jsonl`);
	await assertNoSymlinkParents(canonicalHome, path);
	return path;
}

/** Only the bounded, identity-bearing synthetic metadata line establishes history presence. */
export async function hasFakeCodexHistory(path: string, sessionId: string): Promise<boolean> {
	let file: FileHandle;
	try {
		file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
	try {
		if (!(await file.stat()).isFile()) throw new Error("Fake Codex history must be a regular file.");
		const buffer = Buffer.alloc(4_096);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		const contents = buffer.subarray(0, bytesRead).toString("utf8");
		const newline = contents.indexOf("\n");
		if (newline < 0) return false;
		const metadata = z.object({ type: z.literal("session_meta"), payload: z.object({ id: z.literal(sessionId) }) });
		try {
			return metadata.safeParse(JSON.parse(contents.slice(0, newline))).success;
		} catch {
			return false;
		}
	} finally {
		await file.close();
	}
}

/** A real fresh Codex launch creates history; only fresh synthetic launches may create this header. */
export async function initializeFreshFakeCodexHistory(
	path: string,
	sessionId: string,
	cliVersion: string,
): Promise<void> {
	identitySchema.parse(sessionId);
	z.string()
		.regex(/^\d+\.\d+\.\d+$/)
		.parse(cliVersion);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	let file: FileHandle;
	try {
		file = await open(path, "wx", 0o600);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EEXIST") return;
		throw error;
	}
	try {
		await file.writeFile(
			`${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cli_version: cliVersion, history_mode: "legacy" } })}\n`,
			"utf8",
		);
	} finally {
		await file.close();
	}
}

export function resolveFakeInvocationReceiptPath(options: { stateHome: string; sessionInstanceId: string }): string {
	if (!isAbsolute(options.stateHome)) throw new Error("Fake invocation state home must be absolute.");
	identitySchema.parse(options.sessionInstanceId);
	return join(options.stateHome, "agent-lab", "fake-invocations", `${options.sessionInstanceId}.json`);
}

export async function writeFakeInvocationReceipt(options: {
	stateHome: string;
	receipt: FakeInvocationReceipt;
}): Promise<void> {
	const receipt = FakeInvocationReceiptSchema.parse(options.receipt);
	const stateHome = await realpath(options.stateHome);
	const path = resolveFakeInvocationReceiptPath({ stateHome, sessionInstanceId: receipt.sessionInstanceId });
	await assertNoSymlinkParents(stateHome, path);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const contents = `${JSON.stringify(receipt)}\n`;
	if (Buffer.byteLength(contents) > MAX_RECEIPT_BYTES)
		throw new Error("Fake invocation receipt exceeded its byte limit.");
	const temporaryPath = `${path}.${receipt.pid}.tmp`;
	const file = await open(temporaryPath, "wx", 0o600);
	try {
		await file.writeFile(contents, "utf8");
		await file.close();
		await rename(temporaryPath, path);
	} finally {
		await file.close();
		await unlink(temporaryPath).catch((error: unknown) => {
			if (!isMissing(error)) throw error;
		});
	}
}

export async function readFakeInvocationReceipt(options: {
	stateHome: string;
	sessionInstanceId: string;
}): Promise<FakeInvocationReceipt | null> {
	const stateHome = await realpath(options.stateHome);
	const path = resolveFakeInvocationReceiptPath({ stateHome, sessionInstanceId: options.sessionInstanceId });
	await assertNoSymlinkParents(stateHome, path);
	let file: FileHandle;
	try {
		file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}
	try {
		if (!(await file.stat()).isFile()) throw new Error("Fake invocation receipt must be a regular file.");
		const buffer = Buffer.alloc(MAX_RECEIPT_BYTES + 1);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		if (bytesRead > MAX_RECEIPT_BYTES) throw new Error("Fake invocation receipt exceeded its byte limit.");
		const receipt = FakeInvocationReceiptSchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
		if (receipt.sessionInstanceId !== options.sessionInstanceId)
			throw new Error("Fake invocation receipt has another launch identity.");
		return receipt;
	} finally {
		await file.close();
	}
}
