import { win32 } from "node:path";

/**
 * Application guardrails, not discovered OS limits. Preflight deterministically
 * rejects launches beyond these known policies; passing it does not prove every
 * host can launch. The fallback classifier handles synchronous thrown errors
 * only. Linux execvp failures can instead appear as child output and exit 1;
 * Windows ConPTY process creation can fail asynchronously with ambiguous 206.
 * Neither terminal output nor those exits/codes are interpreted as size proof.
 */
export interface ProcessLaunchBudgetPolicy {
	combinedBytes?: number;
	stringBytes?: number;
	commandLineCodeUnits?: number;
	cmdCommandLineCodeUnits?: number;
	headroomBytes?: number;
}

export interface ProcessLaunchBudgetInput {
	binary: string;
	args: readonly string[] | string;
	env: NodeJS.ProcessEnv;
	platform: NodeJS.Platform;
}

export type ProcessLaunchSizeSource = "arguments" | "environment" | "combined";

export interface ProcessLaunchBudgetViolation {
	source: ProcessLaunchSizeSource;
	unit: "bytes" | "UTF-16 code units";
	estimatedSize: number;
	budget: number;
}

/**
 * No per-launch getconf/sysctl subprocesses. These bounded policies cover ordinary
 * launches without pretending to discover stack limits or every kernel's ARG_MAX.
 * macOS: 1 MiB policy preserves large launches on current hosts; some older
 * kernels allow less, where synchronous posix_spawn errors provide the fallback.
 * Linux: common 2 MiB aggregate and 32 * 4 KiB per string. Actual limits depend
 * on RLIMIT_STACK and page size; smaller child-side exec limits cannot always be
 * classified. The 16 KiB reserve covers native/helper argv, pointer/alignment
 * and loader overhead.
 * Windows: CreateProcessW allows 32,767 UTF-16 units including terminating NUL,
 * but our policy reserves 2 KiB for downstream PowerShell/native reserialization.
 * cmd.exe has a separate 8,191-character parser limit; reserve 256 units there.
 * These margins are bounded policy, not proof of every downstream parser limit.
 * Modern Unicode Windows environment blocks do NOT have the old CreateProcessA
 * 32 KiB total limit.
 */
export function getProcessLaunchBudgetPolicy(platform: NodeJS.Platform): ProcessLaunchBudgetPolicy {
	switch (platform) {
		case "darwin":
			return { combinedBytes: 1024 * 1024, headroomBytes: 16 * 1024 };
		case "linux":
			return { combinedBytes: 2 * 1024 * 1024, stringBytes: 128 * 1024, headroomBytes: 16 * 1024 };
		case "win32":
			return { commandLineCodeUnits: 32_767 - 2048, cmdCommandLineCodeUnits: 8191 - 256 };
		default:
			return {};
	}
}

/** Size of node-pty's Windows argv serialization, without constructing/logging it. */
function windowsArgumentCodeUnits(value: string): number {
	// Keep this in step with node-pty's windowsPtyAgent.argsToCommandLine. In
	// particular, enclosing quotes suppress its added whitespace quotes.
	const quote =
		value === "" ||
		((value.includes(" ") || value.includes("\t")) &&
			value.length > 1 &&
			(value[0] !== '"' || value[value.length - 1] !== '"'));
	let size = quote ? 2 : 0;
	let backslashes = 0;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (character === "\\") {
			backslashes += 1;
		} else {
			size += character === '"' ? backslashes * 2 + 2 : backslashes + 1;
			backslashes = 0;
		}
	}
	return size + backslashes * (quote ? 2 : 1);
}

export function estimateWindowsCommandLineCodeUnits(binary: string, args: readonly string[] | string): number {
	const executableSize = windowsArgumentCodeUnits(binary);
	if (typeof args === "string") {
		// node-pty passes a pre-escaped string verbatim, after its quoted executable.
		return args.length > 0 ? executableSize + 1 + args.length + 1 : binary.length + 1;
	}
	return executableSize + args.reduce((size, argument) => size + 1 + windowsArgumentCodeUnits(argument), 0) + 1;
}

export function findProcessLaunchBudgetViolation(
	input: ProcessLaunchBudgetInput,
	policy = getProcessLaunchBudgetPolicy(input.platform),
): ProcessLaunchBudgetViolation | null {
	if (input.platform === "win32") {
		const estimatedSize = estimateWindowsCommandLineCodeUnits(input.binary, input.args);
		const commandBudget = policy.commandLineCodeUnits;
		if (commandBudget !== undefined && estimatedSize > commandBudget) {
			return { source: "arguments", unit: "UTF-16 code units", estimatedSize, budget: commandBudget };
		}
		if (win32.basename(input.binary).toLowerCase() === "cmd.exe" && policy.cmdCommandLineCodeUnits !== undefined) {
			// Count the entire resolved line, conservatively including cmd's own
			// executable and switches as well as the escaped /c payload.
			if (estimatedSize > policy.cmdCommandLineCodeUnits) {
				return {
					source: "arguments",
					unit: "UTF-16 code units",
					estimatedSize,
					budget: policy.cmdCommandLineCodeUnits,
				};
			}
		}
		return null;
	}

	const args = typeof input.args === "string" ? [input.args] : input.args;
	let argumentBytes = 0;
	let environmentBytes = 0;
	let largestArgumentBytes = 0;
	let largestEnvironmentBytes = 0;
	for (const argument of [input.binary, ...args]) {
		const size = Buffer.byteLength(argument, "utf8") + 1;
		argumentBytes += size;
		largestArgumentBytes = Math.max(largestArgumentBytes, size);
	}
	let environmentCount = 0;
	for (const [key, value] of Object.entries(input.env)) {
		// node-pty serializes own keys as key=value (including an undefined value).
		const size = Buffer.byteLength(key, "utf8") + 1 + Buffer.byteLength(String(value), "utf8") + 1;
		environmentBytes += size;
		largestEnvironmentBytes = Math.max(largestEnvironmentBytes, size);
		environmentCount += 1;
	}
	if (policy.stringBytes !== undefined) {
		if (largestEnvironmentBytes > policy.stringBytes) {
			return {
				source: "environment",
				unit: "bytes",
				estimatedSize: largestEnvironmentBytes,
				budget: policy.stringBytes,
			};
		}
		if (largestArgumentBytes > policy.stringBytes) {
			return { source: "arguments", unit: "bytes", estimatedSize: largestArgumentBytes, budget: policy.stringBytes };
		}
	}
	if (policy.combinedBytes === undefined) return null;
	// Use 64-bit pointers conservatively, including both terminating null pointers.
	const argumentFootprint = argumentBytes + (args.length + 2) * 8;
	const environmentFootprint = environmentBytes + (environmentCount + 1) * 8;
	const estimatedSize = argumentFootprint + environmentFootprint;
	const budget = Math.max(0, policy.combinedBytes - (policy.headroomBytes ?? 0));
	if (estimatedSize <= budget) return null;
	const source = environmentFootprint > budget ? "environment" : argumentFootprint > budget ? "arguments" : "combined";
	return { source, unit: "bytes", estimatedSize, budget };
}

export function isNativeProcessLaunchSizeError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	if ("code" in error && error.code === "E2BIG") return true;
	if (!(error instanceof Error)) return false;
	// Installed node-pty's Windows source reports only "Cannot create process,
	// error code: 206", which can mean an overlong executable path. cmd's console
	// message is not a thrown error either. Neither is evidence for this classifier.
	return /^(?:posix_spawn failed:\s*)?argument list too long\b/iu.test(error.message);
}
