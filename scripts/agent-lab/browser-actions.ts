import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { requestRuntimeDiagnostic, selectRuntimeDiagnosticInstance } from "../../src/diagnostics";
import { AGENT_LAB_REPO_ROOT, getAgentLabArtifactRoot, readAgentLabManifest, resolveRunArtifactDir } from "./paths";
import type { ReadableAgentLabManifest } from "./types";

const ACTION_TRANSCRIPT_NAME = "browser-actions.jsonl";
const MAX_ARGUMENTS = 30;
const MAX_ARGUMENT_LENGTH = 1_000;
const BROWSER_COMMANDS = new Set([
	"open",
	"snapshot",
	"click",
	"dblclick",
	"fill",
	"type",
	"press",
	"hover",
	"find",
	"resize",
	"screenshot",
	"tracing-start",
	"tracing-stop",
	"console",
	"requests",
	"eval",
	"close",
]);

export interface AgentBrowserActionContext {
	actionId: string;
	manifest: ReadableAgentLabManifest;
	category: string;
	arguments: string[];
	artifacts: string[];
	startedAt: string;
	startedAtMs: number;
}

export class AgentBrowserActionBlockedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentBrowserActionBlockedError";
	}
}

interface BrowserActionRecord {
	version: 1;
	actionId: string;
	stage: "started" | "completed";
	timestamp: string;
	monotonicOffsetMs: number;
	runId: string;
	browserSession: string;
	category: string;
	arguments: string[];
	artifacts: string[];
	markId: string | null;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	errorClass: string | null;
}

function readOption(args: readonly string[], longName: string): string | null {
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === longName) return args[index + 1] ?? null;
		if (argument?.startsWith(`${longName}=`)) return argument.slice(longName.length + 1);
	}
	return null;
}

function readSession(args: readonly string[]): string | null {
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "-s" || argument === "--session") return args[index + 1] ?? null;
		if (argument?.startsWith("-s=")) return argument.slice(3);
		if (argument?.startsWith("--session=")) return argument.slice("--session=".length);
	}
	return null;
}

function findCategory(args: readonly string[]): string {
	return args.find((argument) => BROWSER_COMMANDS.has(argument)) ?? "unknown";
}

function isAgentBrowserActionAllowed(manifest: Pick<ReadableAgentLabManifest, "status">, category: string): boolean {
	return category === "close" || manifest.status === "ready" || manifest.status === "restarting";
}

function assertManifestAllowsBrowserAction(manifest: ReadableAgentLabManifest, category: string): void {
	if (isAgentBrowserActionAllowed(manifest, category)) return;
	throw new AgentBrowserActionBlockedError(
		`Agent Lab browser command ${JSON.stringify(category)} is unavailable while run ${manifest.runId} is ${manifest.status}.`,
	);
}

function isWithin(root: string, candidate: string): boolean {
	const relativePath = relative(resolve(root), resolve(candidate));
	return (
		relativePath === "" ||
		(!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
	);
}

function aliasPath(manifest: ReadableAgentLabManifest, candidate: string): string | null {
	if (!isAbsolute(candidate)) return null;
	for (const [root, alias] of [
		[manifest.artifactDir, "$LAB_ARTIFACT"],
		[manifest.tempRoot, "$LAB_TMP"],
		[manifest.repoRoot, "$REPO"],
	] as const) {
		if (isWithin(root, candidate)) {
			const suffix = relative(root, candidate).replaceAll("\\", "/");
			return suffix ? `${alias}/${suffix}` : alias;
		}
	}
	return "[external-path]";
}

function summarizeArgument(manifest: ReadableAgentLabManifest, argument: string): string {
	const equals = argument.indexOf("=");
	if (equals > 0) {
		const option = argument.slice(0, equals + 1);
		const value = argument.slice(equals + 1);
		const aliased = aliasPath(manifest, value);
		return `${option}${aliased ?? value.slice(0, MAX_ARGUMENT_LENGTH)}`;
	}
	return (aliasPath(manifest, argument) ?? argument).slice(0, MAX_ARGUMENT_LENGTH);
}

function summarizeArguments(manifest: ReadableAgentLabManifest, args: readonly string[]): string[] {
	return args.slice(0, MAX_ARGUMENTS).map((argument) => summarizeArgument(manifest, argument));
}

function collectArtifactArguments(manifest: ReadableAgentLabManifest, args: readonly string[]): string[] {
	const artifacts: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		const value =
			argument === "--filename"
				? args[index + 1]
				: argument?.startsWith("--filename=")
					? argument.slice("--filename=".length)
					: undefined;
		if (!value) continue;
		artifacts.push(aliasPath(manifest, value) ?? basename(value));
	}
	return artifacts;
}

async function resolveManifest(args: readonly string[]): Promise<ReadableAgentLabManifest | null> {
	const session = readSession(args);
	if (!session) return null;
	const configPath = readOption(args, "--config");
	const manifestPath = configPath
		? join(dirname(resolve(configPath)), "manifest.json")
		: session.startsWith("qd-")
			? join(resolveRunArtifactDir(session.slice(3), getAgentLabArtifactRoot(AGENT_LAB_REPO_ROOT)), "manifest.json")
			: null;
	if (!manifestPath) return null;
	try {
		const manifest = await readAgentLabManifest(manifestPath);
		return manifest.browserSession === session ? manifest : null;
	} catch {
		return null;
	}
}

async function appendRecord(manifest: ReadableAgentLabManifest, record: BrowserActionRecord): Promise<void> {
	await appendFile(join(manifest.artifactDir, ACTION_TRANSCRIPT_NAME), `${JSON.stringify(record)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}

async function addDiagnosticMark(
	manifest: ReadableAgentLabManifest,
	context: AgentBrowserActionContext,
	stage: "before" | "after",
): Promise<string | null> {
	try {
		const instance = await selectRuntimeDiagnosticInstance({
			stateHome: manifest.statePath,
			runtimePid: manifest.processes.runtime?.pid,
		});
		if (!instance?.pidAlive) return null;
		const payload = (await requestRuntimeDiagnostic(instance, "/api/diagnostics/mark", {
			method: "POST",
			body: { message: `agent-lab browser ${context.category} ${stage} (${context.actionId})` },
			timeoutMs: 500,
		})) as { record?: { id?: unknown } | null };
		return typeof payload.record?.id === "string" ? payload.record.id : null;
	} catch {
		return null;
	}
}

function monotonicOffset(manifest: ReadableAgentLabManifest, timestampMs: number): number {
	return Math.max(0, timestampMs - Date.parse(manifest.createdAt));
}

export async function beginAgentBrowserAction(args: readonly string[]): Promise<AgentBrowserActionContext | null> {
	const manifest = await resolveManifest(args);
	if (!manifest) return null;
	const category = findCategory(args);
	assertManifestAllowsBrowserAction(manifest, category);
	const startedAtMs = Date.now();
	const context: AgentBrowserActionContext = {
		actionId: randomUUID(),
		manifest,
		category,
		arguments: summarizeArguments(manifest, args),
		artifacts: collectArtifactArguments(manifest, args),
		startedAt: new Date(startedAtMs).toISOString(),
		startedAtMs,
	};
	const markId = await addDiagnosticMark(manifest, context, "before");
	await appendRecord(manifest, {
		version: 1,
		actionId: context.actionId,
		stage: "started",
		timestamp: context.startedAt,
		monotonicOffsetMs: monotonicOffset(manifest, startedAtMs),
		runId: manifest.runId,
		browserSession: manifest.browserSession,
		category: context.category,
		arguments: context.arguments,
		artifacts: context.artifacts,
		markId,
		exitCode: null,
		signal: null,
		errorClass: null,
	});
	return context;
}

export async function assertAgentBrowserActionCanLaunch(args: readonly string[]): Promise<void> {
	const manifest = await resolveManifest(args);
	if (!manifest) return;
	assertManifestAllowsBrowserAction(manifest, findCategory(args));
}

export async function completeAgentBrowserAction(
	context: AgentBrowserActionContext | null,
	result: { exitCode: number | null; signal: NodeJS.Signals | null; error: Error | null },
): Promise<void> {
	if (!context) return;
	const completedAtMs = Date.now();
	const markId = await addDiagnosticMark(context.manifest, context, "after");
	await appendRecord(context.manifest, {
		version: 1,
		actionId: context.actionId,
		stage: "completed",
		timestamp: new Date(completedAtMs).toISOString(),
		monotonicOffsetMs: monotonicOffset(context.manifest, completedAtMs),
		runId: context.manifest.runId,
		browserSession: context.manifest.browserSession,
		category: context.category,
		arguments: context.arguments,
		artifacts: context.artifacts,
		markId,
		exitCode: result.exitCode,
		signal: result.signal,
		errorClass: result.error?.name ?? null,
	});
}

export const _testing = {
	aliasPath,
	collectArtifactArguments,
	findCategory,
	isAgentBrowserActionAllowed,
	readSession,
	summarizeArguments,
};
