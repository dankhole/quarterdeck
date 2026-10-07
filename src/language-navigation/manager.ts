import { realpath } from "node:fs/promises";
import type { Hover, MarkedString } from "vscode-languageserver-protocol";
import type {
	CodeNavigationHoverResponse,
	CodeNavigationRequest,
	CodeNavigationResponse,
	CodeNavigationStatus,
	LspServerConfig,
} from "../core/api/code-navigation";
import { mergeProcessEnvironment } from "../core/process-environment";
import type { RuntimeDiagnostics } from "../diagnostics";
import { isBinaryWorkdirFileBuffer, MAX_WORKDIR_FILE_EDIT_SIZE, openWorkdirFile } from "../workdir/read-workdir-file";
import { assertMutableWorkdirPath, normalizeWorkdirRelativePath } from "../workdir/workdir-path-policy";
import { resolveLanguageServerCommand } from "./command";
import { LanguageNavigationError, type LanguageNavigationFailureMetadata } from "./failure";
import { mapNavigationLocations, resolveLanguageRoot, selectLanguageServer } from "./paths";
import { LanguageSession, type NavigationDocument } from "./session";

export interface CodeNavigationConfig {
	codeNavigationEnabled: boolean;
	lspServers: LspServerConfig[];
}
interface SessionEntry {
	projectId: string;
	fingerprint: string;
	session: LanguageSession;
}
interface NavigationScope {
	projectId: string;
	cwd: string;
}
interface ManagerOptions {
	diagnostics?: Pick<RuntimeDiagnostics, "recordEvent">;
	idleTimeoutMs?: number;
	requestTimeoutMs?: number;
}

/** Owns process reuse and bounded lifecycle policy; protocol/document correctness lives in LanguageSession. */
export class LanguageNavigationManager {
	private readonly sessions = new Map<string, SessionEntry>();
	private readonly idleTimer: NodeJS.Timeout;
	private epoch = 0;
	private closed = false;
	private readonly removedProjects = new Set<string>();
	get generation(): number {
		return this.epoch;
	}
	restoreProject(projectId: string): void {
		if (this.removedProjects.delete(projectId)) this.epoch++;
	}

	constructor(private readonly options: ManagerOptions = {}) {
		this.idleTimer = setInterval(
			() => {
				void this.reapIdle().catch(() => undefined);
			},
			Math.min(options.idleTimeoutMs ?? 15 * 60_000, 60_000),
		);
		this.idleTimer.unref();
	}

	async status(config: CodeNavigationConfig, path: string): Promise<CodeNavigationStatus> {
		if (!config.codeNavigationEnabled)
			return { status: "disabled", message: "Enable Code Navigation in Settings to use a language server." };
		const server = selectLanguageServer(config.lspServers, path);
		if (!server)
			return {
				status: "unavailable",
				message: "No enabled language server matches this file. Configure one in Settings.",
			};
		const command = await resolveLanguageServerCommand(
			server.command,
			mergeProcessEnvironment(process.env, server.env ?? {}),
		);
		return {
			status: command ? "ready" : "unavailable",
			serverId: server.id,
			command: server.command,
			message: command
				? `${server.label} is ready to start on demand.`
				: `Cannot directly execute ${server.command}. Check the command in Settings and the runtime's PATH.`,
		};
	}

	async navigate(
		operation: "definition" | "references",
		scope: NavigationScope,
		config: CodeNavigationConfig,
		input: CodeNavigationRequest,
		generation = this.epoch,
	): Promise<CodeNavigationResponse> {
		const serverId = selectLanguageServer(config.lspServers, input.path)?.id;
		try {
			if (generation !== this.epoch)
				throw new LanguageNavigationError(
					"Code navigation configuration or project scope changed. Try again.",
					false,
					{ stage: "admission", category: "scope_changed" },
				);
			const { session, document, root } = await this.prepare(scope, config, input);
			const result =
				operation === "definition"
					? await session.definition(document)
					: await session.references(document, input.includeDeclaration ?? true);
			const mapped = await mapNavigationLocations(root, result);
			this.record(scope.projectId, "request_completed", {
				operation,
				...(serverId ? { serverId } : {}),
				resultCount: mapped.locations.length,
			});
			return { status: "ok", ...mapped, documentVersion: input.documentVersion };
		} catch (error) {
			return this.failure(scope.projectId, input.documentVersion, error, operation, serverId);
		}
	}

	async hover(
		scope: NavigationScope,
		config: CodeNavigationConfig,
		input: CodeNavigationRequest,
		generation = this.epoch,
	): Promise<CodeNavigationHoverResponse> {
		const serverId = selectLanguageServer(config.lspServers, input.path)?.id;
		try {
			if (generation !== this.epoch)
				throw new LanguageNavigationError(
					"Code navigation configuration or project scope changed. Try again.",
					false,
					{ stage: "admission", category: "scope_changed" },
				);
			const { session, document } = await this.prepare(scope, config, input);
			const hover = await session.hover(document);
			return {
				status: "ok",
				contents: hoverText(hover).slice(0, 32_768),
				...(hover?.range ? { range: hover.range } : {}),
				documentVersion: input.documentVersion,
			};
		} catch (error) {
			return this.failure(scope.projectId, input.documentVersion, error, "hover", serverId);
		}
	}

	private failure(
		projectId: string,
		documentVersion: number,
		error: unknown,
		operation: "definition" | "references" | "hover",
		serverId: string | undefined,
	): { status: "unavailable" | "error"; message: string; documentVersion: number } {
		const metadata: LanguageNavigationFailureMetadata =
			error instanceof LanguageNavigationError ? error.metadata : { stage: "admission", category: "internal_error" };
		this.record(projectId, "request_failed", {
			operation,
			...(serverId ? { serverId } : {}),
			...metadata,
		});
		return {
			status: error instanceof LanguageNavigationError && error.unavailable ? "unavailable" : "error",
			message:
				error instanceof LanguageNavigationError
					? error.message
					: "Code navigation failed. Check the configured language server and try again.",
			documentVersion,
		};
	}

	private async prepare(
		scope: NavigationScope,
		config: CodeNavigationConfig,
		input: CodeNavigationRequest,
	): Promise<{ session: LanguageSession; document: NavigationDocument; root: string }> {
		const epoch = this.epoch;
		if (this.closed)
			throw new LanguageNavigationError("Code navigation is shutting down.", false, {
				stage: "admission",
				category: "stopped",
			});
		if (this.removedProjects.has(scope.projectId))
			throw new LanguageNavigationError("The project is being removed.", true, {
				stage: "admission",
				category: "scope_changed",
			});
		if (!config.codeNavigationEnabled)
			throw new LanguageNavigationError("Enable Code Navigation in Settings first.", true, {
				stage: "admission",
				category: "unavailable",
			});
		const path = normalizeWorkdirRelativePath(input.path);
		assertMutableWorkdirPath(path);
		if (Buffer.byteLength(input.content, "utf8") > MAX_WORKDIR_FILE_EDIT_SIZE || input.content.includes("\0")) {
			throw new LanguageNavigationError(
				"Code navigation requires a text document within the 5 MB editor limit.",
				true,
				{ stage: "admission", category: "invalid_document" },
			);
		}
		const lines = input.content.split(/\r\n|\r|\n/);
		const line = lines[input.position.line];
		if (line === undefined || input.position.character > line.length)
			throw new LanguageNavigationError("The selected position is outside the current document.", false, {
				stage: "admission",
				category: "invalid_document",
			});
		const server = selectLanguageServer(config.lspServers, path);
		if (!server)
			throw new LanguageNavigationError(
				"No enabled language server matches this file. Configure one in Settings.",
				true,
				{ stage: "admission", category: "unavailable" },
			);
		const root = await realpath(scope.cwd);
		const opened = await openWorkdirFile(root, path);
		try {
			if (opened.fileStat.size > MAX_WORKDIR_FILE_EDIT_SIZE)
				throw new LanguageNavigationError("The file exceeds the 5 MB editor limit.", true, {
					stage: "admission",
					category: "invalid_document",
				});
			const buffer = Buffer.alloc(Math.min(opened.fileStat.size, 8192));
			const { bytesRead } = await opened.fileHandle.read(buffer, 0, buffer.length, 0);
			if (isBinaryWorkdirFileBuffer(buffer.subarray(0, bytesRead)))
				throw new LanguageNavigationError("Binary files do not support code navigation.", true, {
					stage: "admission",
					category: "invalid_document",
				});
		} finally {
			await opened.fileHandle.close();
		}
		const languageRoot = await resolveLanguageRoot(root, opened.absolutePath, server.rootMarkers);
		const command = await resolveLanguageServerCommand(
			server.command,
			mergeProcessEnvironment(process.env, server.env ?? {}),
		);
		if (!command)
			throw new LanguageNavigationError(
				`Cannot directly execute ${server.command}. Configure an executable on the runtime's PATH or an absolute executable path.`,
				true,
				{ stage: "admission", category: "unavailable" },
			);
		if (epoch !== this.epoch || this.closed)
			throw new LanguageNavigationError(
				"Code navigation configuration or project scope changed. Try again.",
				false,
				{ stage: "admission", category: "scope_changed" },
			);
		const key = JSON.stringify([scope.projectId, root, server.id, languageRoot]);
		const fingerprint = JSON.stringify([command, server]);
		let entry = this.sessions.get(key);
		if (entry && (entry.fingerprint !== fingerprint || entry.session.isStopped)) {
			await entry.session.stop();
			entry = undefined;
		}
		if (epoch !== this.epoch || this.closed)
			throw new LanguageNavigationError(
				"Code navigation configuration or project scope changed. Try again.",
				false,
				{ stage: "admission", category: "scope_changed" },
			);
		// Another request may have installed this session while an obsolete one was stopping.
		entry ??= this.sessions.get(key);
		if (!entry) {
			if (
				this.sessions.size >= 16 ||
				[...this.sessions.values()].filter((value) => value.projectId === scope.projectId).length >= 3
			) {
				throw new LanguageNavigationError(
					"The language server process limit has been reached. Close idle workspaces or wait for idle shutdown.",
					true,
					{ stage: "admission", category: "process_limit" },
				);
			}
			const session = new LanguageSession({
				command,
				config: server,
				root: languageRoot,
				requestTimeoutMs: this.options.requestTimeoutMs,
				onStopped: (failure) => {
					if (this.sessions.get(key)?.session === session) this.sessions.delete(key);
					this.record(scope.projectId, "stopped", { serverId: server.id, ...failure });
				},
			});
			entry = { projectId: scope.projectId, fingerprint, session };
			this.sessions.set(key, entry);
			this.record(scope.projectId, "started", { serverId: server.id });
		}
		return {
			session: entry.session,
			root,
			document: { path: opened.absolutePath, content: input.content, position: input.position },
		};
	}

	getSnapshot(projectId?: string): { processCount: number; pendingRequests: number } {
		const entries = [...this.sessions.values()].filter((value) => !projectId || value.projectId === projectId);
		return {
			processCount: entries.length,
			pendingRequests: entries.reduce((sum, entry) => sum + entry.session.pendingRequests, 0),
		};
	}

	async stopProject(projectId: string): Promise<void> {
		this.epoch++;
		this.removedProjects.add(projectId);
		const entries = [...this.sessions.entries()].filter(([, entry]) => entry.projectId === projectId);
		await Promise.all(entries.map(([, entry]) => entry.session.stop()));
	}

	async reset(): Promise<void> {
		this.epoch++;
		const sessions = [...this.sessions.values()];
		await Promise.all(sessions.map((entry) => entry.session.stop()));
	}

	/** Reject new launches without signaling children before their ownership snapshot. */
	fenceLaunches(): void {
		this.closed = true;
		this.epoch++;
		clearInterval(this.idleTimer);
	}

	async close(): Promise<void> {
		this.fenceLaunches();
		await this.reset();
	}

	private async reapIdle(): Promise<void> {
		const now = Date.now();
		await Promise.all(
			[...this.sessions.values()]
				.filter(
					(entry) =>
						entry.session.pendingRequests === 0 &&
						now - entry.session.lastUsedAt >= (this.options.idleTimeoutMs ?? 15 * 60_000),
				)
				.map((entry) => entry.session.stop()),
		);
	}

	private record(projectId: string, event: string, payload: Record<string, string | number>): void {
		this.options.diagnostics?.recordEvent(`code_navigation.${event}`, payload, { projectId }, { essential: true });
	}
}

function hoverText(hover: Hover | null): string {
	if (!hover) return "";
	const contents = hover.contents;
	const markedText = (value: MarkedString) => (typeof value === "string" ? value : value.value);
	return Array.isArray(contents)
		? contents.map(markedText).join("\n\n")
		: typeof contents === "string"
			? contents
			: contents.value;
}
