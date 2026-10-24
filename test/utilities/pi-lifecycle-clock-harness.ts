import { EventEmitter } from "node:events";
import { realpath } from "node:fs/promises";
import http from "node:http";
import { isAbsolute } from "node:path";
import { createContext, Script } from "node:vm";

import { type Mock, vi } from "vitest";

import { appendMetadataFlags, buildHookIngestRequest } from "../../src/commands/hook-metadata";
import type { RuntimeHookIngestRequest } from "../../src/core/api/task-session";
import { createHookDeliveryIdGenerator } from "../../src/hook-delivery-order";
import { HookPublicationUnavailableError } from "../../src/hook-reliable-delivery";
import {
	buildPiLifecycleExtensionSource,
	QUARTERDECK_PI_HOOK_COMMAND_ENV,
} from "../../src/terminal/pi-lifecycle-extension";

export const PI_BACKGROUND_GRACE_MS = 3_000;
export const PI_BACKGROUND_HOLD_MS = 60 * 60_000;
const MANAGER_KEY = Symbol.for("pi-subagents:manager");

type Handler = (event: Record<string, unknown>, context: LifecycleContext) => unknown;
export interface LifecycleContext {
	cwd?: string;
	ui: { notify(message: string, type?: string): void };
	sessionManager: { getSessionId(): string; getSessionFile?(): string | null };
	isIdle?(): boolean;
}

export interface PiLifecycleClockHarness {
	calls: string[][];
	handlers: Map<string, Handler>;
	publications: RuntimeHookIngestRequest[];
	deliveries: RuntimeHookIngestRequest[];
	abandoned: RuntimeHookIngestRequest[];
	diagnostics: {
		error: Mock<(message: string) => void>;
		warn: Mock<(message: string) => void>;
	};
	records: Map<string, unknown>;
	manager: {
		getRecord: Mock<(id: string) => unknown>;
		hasRunning: Mock<() => unknown>;
		waitForAll: Mock<() => unknown>;
		spawn: Mock<() => unknown>;
	};
	bus: {
		on: Mock<(channel: string, handler: (payload: unknown) => void) => () => void>;
		emit: Mock<(channel: string, payload: unknown) => void>;
	};
	spawn: Mock<(binary: string, args: string[]) => EventEmitter>;
	context: LifecycleContext;
	drain(): Promise<void>;
	advance(ms: number): Promise<void>;
	fire(name: string, event?: Record<string, unknown>, ctx?: LifecycleContext): unknown;
	setRegistry(value: unknown): void;
	timerCount(): number;
	listenerCount(): number;
	hooks(): Array<string | undefined>;
	reviews(): string[][];
	boot(): Promise<void>;
	dispose(): Promise<void>;
}

export function hookFlag(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index < 0 ? undefined : args[index + 1];
}

/**
 * Executes the emitted asset, not a reimplementation of its lifecycle logic.
 * Only its static node imports/export syntax are linked to inert host facades;
 * the original test file retains real ESM/Node process and HTTP coverage.
 * Each VM owns its global registry, bus, environment, clock and hook queue.
 */
export function createPiLifecycleClockHarness(
	options: {
		bus?: boolean;
		realClock?: boolean;
		registry?: unknown;
		deliveryRegistry?: Map<string, unknown>;
		launchIdentity?: { projectId: string; taskId: string; sessionInstanceId: string };
		runIdPrefix?: string;
		publish?: (request: RuntimeHookIngestRequest) => Promise<void>;
		deliver?: (request: RuntimeHookIngestRequest, signal: AbortSignal) => Promise<"deferred" | undefined>;
		abandon?: (request: RuntimeHookIngestRequest) => Promise<void>;
	} = {},
): PiLifecycleClockHarness {
	let now = 1_000_000;
	let nextTimerId = 0;
	let nextRunId = 0;
	const timers = new Map<number, { due: number; callback: () => void }>();
	const handlers = new Map<string, Handler>();
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	const calls: string[][] = [];
	const publications: RuntimeHookIngestRequest[] = [];
	const deliveries: RuntimeHookIngestRequest[] = [];
	const abandoned: RuntimeHookIngestRequest[] = [];
	const diagnostics = { error: vi.fn<(message: string) => void>(), warn: vi.fn<(message: string) => void>() };
	const records = new Map<string, unknown>();
	const getRecord = vi.fn((id: string) => records.get(id));
	const manager: PiLifecycleClockHarness["manager"] = {
		getRecord,
		hasRunning: vi.fn<() => unknown>(),
		waitForAll: vi.fn<() => unknown>(),
		spawn: vi.fn<() => unknown>(),
	};
	const bus: PiLifecycleClockHarness["bus"] = {
		on: vi.fn((channel: string, handler: (payload: unknown) => void) => {
			const entries = listeners.get(channel) ?? new Set();
			entries.add(handler);
			listeners.set(channel, entries);
			return () => {
				entries.delete(handler);
			};
		}),
		emit: vi.fn((channel: string, payload: unknown) => {
			for (const handler of listeners.get(channel) ?? []) handler(payload);
		}),
	};
	const spawn = vi.fn<(binary: string, args: string[]) => EventEmitter>((_binary, args) => {
		calls.push([...args]);
		const child = Object.assign(new EventEmitter(), { unref: vi.fn(), kill: vi.fn() });
		void Promise.resolve().then(() => child.emit("exit", 0));
		return child;
	});
	const context: LifecycleContext = {
		ui: { notify: vi.fn<(message: string, type?: string) => void>() },
		sessionManager: {
			getSessionId: () => "pi-session-1",
			getSessionFile: () => "/sessions/pi-session-1.json",
		},
		isIdle: () => true,
	};
	const sandbox = createContext({
		spawn,
		buildHookIngestRequest,
		createHookDeliveryIdGenerator,
		HookPublicationUnavailableError,
		publishReliableHook: async (request: RuntimeHookIngestRequest) => {
			publications.push(request);
			await options.publish?.(request);
			calls.push(appendMetadataFlags(["ingest", "--event", request.event], request.metadata));
			return request;
		},
		deliverPublishedHook: async (request: RuntimeHookIngestRequest, { signal }: { signal: AbortSignal }) => {
			deliveries.push(request);
			const status = await options.deliver?.(request, signal);
			return { status: status ?? "acknowledged" };
		},
		abandonPublishedHook: async (request: RuntimeHookIngestRequest) => {
			abandoned.push(request);
			await options.abandon?.(request);
		},
		AbortController,
		console: diagnostics,
		randomUUID: () => `${options.runIdPrefix ?? "turn-"}${++nextRunId}`,
		realpath,
		http,
		isAbsolute,
		URL,
		URLSearchParams,
		Buffer,
		process: {
			env: {
				...process.env,
				[QUARTERDECK_PI_HOOK_COMMAND_ENV]: JSON.stringify(["synthetic-hook", "notify"]),
				QUARTERDECK_HOOK_TASK_ID:
					options.launchIdentity?.taskId ?? process.env.QUARTERDECK_HOOK_TASK_ID ?? "pi-task",
				QUARTERDECK_HOOK_PROJECT_ID:
					options.launchIdentity?.projectId ?? process.env.QUARTERDECK_HOOK_PROJECT_ID ?? "pi-project",
				QUARTERDECK_HOOK_SESSION_INSTANCE_ID:
					options.launchIdentity?.sessionInstanceId ??
					process.env.QUARTERDECK_HOOK_SESSION_INSTANCE_ID ??
					"pi-launch",
			},
		},
		Date: class extends Date {
			static now() {
				return now;
			}
		},
		setTimeout: options.realClock
			? setTimeout
			: (callback: () => void, delay: number) => {
					const id = ++nextTimerId;
					timers.set(id, { due: now + delay, callback });
					return { id, unref() {} };
				},
		clearTimeout: options.realClock ? clearTimeout : (timer: { id: number }) => timers.delete(timer.id),
	});
	Reflect.set(sandbox, MANAGER_KEY, options.registry === undefined ? manager : options.registry);
	if (options.deliveryRegistry)
		Reflect.set(sandbox, Symbol.for("quarterdeck:pi-hook-delivery:v1"), options.deliveryRegistry);
	const source = buildPiLifecycleExtensionSource()
		.replace(/^import .+;\r?\n/gm, "")
		.replace("export default function quarterdeckLifecycle", "function quarterdeckLifecycle");
	new Script(
		`${source}\nglobalThis.initialize = quarterdeckLifecycle;\nglobalThis.drainHooks = async () => { await deliveryState.publicationQueue; await deliveryState.durableHookQueue; if (shutdownPromise) await shutdownPromise; };`,
		{
			filename: "quarterdeck-lifecycle.emitted.js",
		},
	).runInContext(sandbox);
	const initialize = sandbox.initialize as (api: {
		on(name: string, handler: Handler): void;
		events?: typeof bus;
	}) => void;
	initialize({
		on: (name, handler) => handlers.set(name, handler),
		...(options.bus === false ? {} : { events: bus }),
	});

	async function drain() {
		// Await the actual serial durable queue without advancing lifecycle timers.
		await (sandbox.drainHooks as () => Promise<void>)();
	}
	async function advance(ms: number) {
		const target = now + ms;
		await drain();
		for (;;) {
			const next = [...timers.entries()]
				.filter(([, timer]) => timer.due <= target)
				.sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
			if (!next) break;
			now = next[1].due;
			timers.delete(next[0]);
			next[1].callback();
			await drain();
		}
		now = target;
		await drain();
	}
	function fire(name: string, event: Record<string, unknown> = {}, ctx = context) {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`Missing lifecycle handler: ${name}`);
		return handler(event, ctx);
	}
	return {
		calls,
		handlers,
		publications,
		deliveries,
		abandoned,
		diagnostics,
		records,
		manager,
		bus,
		spawn,
		context,
		drain,
		advance,
		fire,
		setRegistry(value: unknown) {
			Reflect.set(sandbox, MANAGER_KEY, value);
		},
		timerCount: () => timers.size,
		listenerCount: () => [...listeners.values()].reduce((sum, entries) => sum + entries.size, 0),
		hooks: () => calls.map((args) => hookFlag(args, "--hook-event-name")),
		reviews: () => calls.filter((args) => hookFlag(args, "--event") === "to_review"),
		async boot() {
			fire("session_start");
			await drain();
			calls.length = 0;
			publications.length = 0;
			deliveries.length = 0;
		},
		async dispose() {
			await fire("session_shutdown");
			await drain();
			timers.clear();
		},
	};
}
