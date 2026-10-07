import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import {
	createProtocolConnection,
	DefinitionRequest,
	DidCloseTextDocumentNotification,
	DidOpenTextDocumentNotification,
	ExitNotification,
	type Hover,
	HoverRequest,
	InitializedNotification,
	InitializeRequest,
	type InitializeResult,
	type Location,
	type LocationLink,
	type Position,
	type ProtocolConnection,
	ReferencesRequest,
	ShutdownRequest,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-languageserver-protocol/node";
import type { LspServerConfig } from "../core/api/code-navigation";
import { mergeProcessEnvironment } from "../core/process-environment";
import { terminateProcessTree } from "../core/process-termination";
import { assertRuntimeProcessLaunchAdmission } from "../core/runtime-process-launch-admission.js";
import { LanguageNavigationError, type LanguageNavigationFailureMetadata } from "./failure";
import { languageIdForPath } from "./paths";
import { spawnWindowsLanguageProcess } from "./windows-process-owner";

export interface NavigationDocument {
	path: string;
	content: string;
	position: Position;
}
export interface LanguageSessionOptions {
	command: string;
	config: LspServerConfig;
	root: string;
	requestTimeoutMs?: number;
	onStopped?: (failure?: LanguageNavigationFailureMetadata) => void;
}

/** One directly launched stdio process. Requests own a short-lived unsaved document. */
export class LanguageSession {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly connection: ProtocolConnection;
	private readonly initialized: Promise<InitializeResult>;
	private readonly requestTimeoutMs: number;
	private tail: Promise<void> = Promise.resolve();
	private queued = 0;
	private documentVersion = 0;
	private stopped = false;
	private initializationComplete = false;
	private terminalFailure: LanguageNavigationError | undefined;
	private outputBytes = 0;
	private stopPromise: Promise<void> | null = null;
	private readonly exited: Promise<void>;
	lastUsedAt = Date.now();

	constructor(private readonly options: LanguageSessionOptions) {
		this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
		const env = mergeProcessEnvironment(process.env, options.config.env ?? {});
		if (process.platform === "win32") {
			this.child = spawnWindowsLanguageProcess(options.command, options.config.args, options.root, env);
		} else {
			assertRuntimeProcessLaunchAdmission();
			this.child = spawn(options.command, options.config.args, {
				cwd: options.root,
				env,
				stdio: "pipe",
				shell: false,
				detached: true,
			});
		}
		this.exited = new Promise((resolve) => {
			this.child.once("close", resolve);
			this.child.once("error", () => resolve());
		});
		this.connection = createProtocolConnection(
			new StreamMessageReader(this.child.stdout),
			new StreamMessageWriter(this.child.stdin),
		);
		this.child.stderr.resume();
		this.child.stdout.on("data", (chunk: Buffer) => {
			this.outputBytes += chunk.length;
			if (this.outputBytes > 32 * 1024 * 1024) {
				this.recordTerminalFailure("The language server exceeded its output limit.", "output_limit");
				this.child.stdout.pause();
				this.connection.dispose();
				void this.stop().catch(() => undefined);
			}
		});
		this.child.once("error", () => {
			this.recordTerminalFailure("The language server could not be started.", "spawn_failed");
			void this.stop().catch(() => undefined);
		});
		this.child.once("exit", (code, signal) => {
			if (!this.stopped)
				this.recordTerminalFailure("The language server process exited.", "process_exited", {
					...(code !== null ? { exitCode: code } : {}),
					...(signal !== null ? { signal } : {}),
				});
			void this.stop().catch(() => undefined);
		});
		// The client does not advertise dynamic registration, configuration, or apply-edit.
		// Discard server notifications (including diagnostics) without retaining their content.
		this.connection.listen();
		const rootUri = pathToFileURL(options.root).href;
		this.initialized = this.bounded(
			this.connection.sendRequest(InitializeRequest.type, {
				processId: process.pid,
				clientInfo: { name: "Quarterdeck" },
				rootUri,
				workspaceFolders: [{ uri: rootUri, name: basename(options.root) }],
				capabilities: {
					general: { positionEncodings: ["utf-16"] },
					textDocument: { definition: { linkSupport: true } },
				},
				initializationOptions: options.config.initializationOptions,
			}),
			"Language server initialization timed out.",
			"initialization",
		)
			.then(async (result) => {
				if (result.capabilities.positionEncoding && result.capabilities.positionEncoding !== "utf-16") {
					throw new LanguageNavigationError(
						"The language server selected an unsupported position encoding.",
						true,
						{ stage: "initialization", category: "unavailable" },
					);
				}
				await this.connection.sendNotification(InitializedNotification.type, {});
				this.initializationComplete = true;
				return result;
			})
			.catch((error: unknown) => {
				throw this.asFailure(error, "initialization");
			});
		// Initialization may fail before a queued request reaches its await.
		void this.initialized.catch(() => this.stop().catch(() => undefined));
	}

	get pendingRequests(): number {
		return this.queued;
	}
	get isStopped(): boolean {
		return this.stopped;
	}

	definition(document: NavigationDocument): Promise<Location | Location[] | LocationLink[] | null> {
		return this.withDocument(document, "definitionProvider", () =>
			this.connection.sendRequest(DefinitionRequest.type, {
				textDocument: { uri: pathToFileURL(document.path).href },
				position: document.position,
			}),
		);
	}

	references(document: NavigationDocument, includeDeclaration: boolean): Promise<Location[] | null> {
		return this.withDocument(document, "referencesProvider", () =>
			this.connection.sendRequest(ReferencesRequest.type, {
				textDocument: { uri: pathToFileURL(document.path).href },
				position: document.position,
				context: { includeDeclaration },
			}),
		);
	}

	hover(document: NavigationDocument): Promise<Hover | null> {
		return this.withDocument(document, "hoverProvider", () =>
			this.connection.sendRequest(HoverRequest.type, {
				textDocument: { uri: pathToFileURL(document.path).href },
				position: document.position,
			}),
		);
	}

	private async withDocument<T>(
		document: NavigationDocument,
		capability: "definitionProvider" | "referencesProvider" | "hoverProvider",
		request: () => Promise<T>,
	): Promise<T> {
		if (this.stopped)
			throw (
				this.terminalFailure ??
				new LanguageNavigationError("The language server has stopped. Try again.", false, {
					stage: "request",
					category: "stopped",
				})
			);
		if (this.queued >= 8)
			throw new LanguageNavigationError("Too many pending code navigation requests. Try again shortly.", false, {
				stage: "request",
				category: "queue_limit",
			});
		this.queued++;
		const previous = this.tail;
		let release = () => {};
		this.tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			await previous;
			if (this.stopped)
				throw (
					this.terminalFailure ??
					new LanguageNavigationError("The language server has stopped. Try again.", false, {
						stage: "request",
						category: "stopped",
					})
				);
			const initialized = await this.initialized;
			if (!initialized.capabilities[capability])
				throw new LanguageNavigationError("The language server does not support this action.", true, {
					stage: "request",
					category: "unavailable",
				});
			const synchronization = initialized.capabilities.textDocumentSync;
			if (
				synchronization === undefined ||
				synchronization === 0 ||
				(typeof synchronization === "object" && !synchronization.openClose)
			) {
				throw new LanguageNavigationError(
					"The language server does not support synchronizing unsaved documents.",
					true,
					{ stage: "request", category: "unavailable" },
				);
			}
			this.outputBytes = 0;
			const uri = pathToFileURL(document.path).href;
			return await this.bounded(
				(async () => {
					await this.connection.sendNotification(DidOpenTextDocumentNotification.type, {
						textDocument: {
							uri,
							languageId: languageIdForPath(document.path),
							version: ++this.documentVersion,
							text: document.content,
						},
					});
					try {
						return await request();
					} finally {
						if (!this.stopped)
							await this.connection.sendNotification(DidCloseTextDocumentNotification.type, {
								textDocument: { uri },
							});
					}
				})(),
				"Code navigation timed out. Try again after the server has indexed the workspace.",
				"request",
			);
		} catch (error) {
			throw this.asFailure(error, "request");
		} finally {
			this.queued--;
			this.lastUsedAt = Date.now();
			release();
		}
	}

	private async bounded<T>(
		work: Promise<T>,
		message: string,
		stage: LanguageNavigationFailureMetadata["stage"],
	): Promise<T> {
		let timer: NodeJS.Timeout | undefined;
		try {
			return await Promise.race([
				work,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						this.terminalFailure ??= new LanguageNavigationError(message, false, { stage, category: "timeout" });
						void this.stop().catch(() => undefined);
						reject(this.terminalFailure);
					}, this.requestTimeoutMs);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	private recordTerminalFailure(
		message: string,
		category: LanguageNavigationFailureMetadata["category"],
		detail: Pick<LanguageNavigationFailureMetadata, "exitCode" | "signal"> = {},
	): void {
		this.terminalFailure ??= new LanguageNavigationError(message, false, {
			stage: this.initializationComplete ? "request" : "initialization",
			category,
			...detail,
		});
	}

	private asFailure(error: unknown, stage: LanguageNavigationFailureMetadata["stage"]): LanguageNavigationError {
		return (
			this.terminalFailure ??
			(error instanceof LanguageNavigationError
				? error
				: new LanguageNavigationError("The language server request failed. Try again.", false, {
						stage,
						category: "protocol_error",
					}))
		);
	}

	stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise;
		this.stopped = true;
		this.stopPromise = this.stopProcess().then(() => this.options.onStopped?.(this.terminalFailure?.metadata));
		return this.stopPromise;
	}

	private async stopProcess(): Promise<void> {
		// Give a responsive server the protocol shutdown handshake; always reap its process group.
		let timer: NodeJS.Timeout | undefined;
		await Promise.race([
			Promise.resolve()
				.then(() => this.connection.sendRequest(ShutdownRequest.type))
				.then(() => this.connection.sendNotification(ExitNotification.type))
				.catch(() => undefined),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, 250);
			}),
		]);
		clearTimeout(timer);
		this.connection.dispose();
		if (process.platform === "win32") {
			// Killing the exact supervisor handle closes its sole Job Object handle.
			// This owns workers even after the actual language server has exited.
			if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
		} else if (this.child.pid) terminateProcessTree(this.child.pid, "SIGKILL");
		this.child.stdin.destroy();
		this.child.stdout.destroy();
		this.child.stderr.destroy();
		await Promise.race([
			this.exited,
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, 1_000);
			}),
		]);
		clearTimeout(timer);
		if (this.child.pid && this.child.exitCode === null && this.child.signalCode === null) {
			throw new LanguageNavigationError("The language server process could not be stopped.", false, {
				stage: "shutdown",
				category: "stop_failed",
			});
		}
	}
}
