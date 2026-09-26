import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSingleTabGuard } from "@/hooks/app/use-single-tab-guard";

// Model the browser's exclusive FIFO queue; aborting a held request does not
// release it. Only settlement of its callback permits the next grant.
function createLockManager() {
	let held = false;
	const pending: Array<() => void> = [];
	const drain = () => {
		if (!held) pending.shift()?.();
	};
	const request = vi.fn((name: string, options: LockOptions, callback: LockGrantedCallback<void>) => {
		return new Promise<void>((resolve, reject) => {
			const grant = () => {
				options.signal?.removeEventListener("abort", abort);
				held = true;
				Promise.resolve(callback({ name, mode: "exclusive" })).then(() => {
					held = false;
					resolve();
					queueMicrotask(drain);
				}, reject);
			};
			const abort = () => {
				const index = pending.indexOf(grant);
				if (index >= 0) pending.splice(index, 1);
				reject(new DOMException("Aborted", "AbortError"));
			};
			options.signal?.addEventListener("abort", abort, { once: true });
			pending.push(grant);
			queueMicrotask(drain);
		});
	});
	return { request };
}

class TestBroadcastChannel {
	static channels = new Set<TestBroadcastChannel>();
	onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
	constructor(readonly name: string) {
		TestBroadcastChannel.channels.add(this);
	}
	postMessage(data: unknown) {
		for (const channel of TestBroadcastChannel.channels) {
			if (channel !== this && channel.name === this.name) {
				queueMicrotask(() => {
					if (TestBroadcastChannel.channels.has(channel))
						channel.onmessage?.(new MessageEvent("message", { data }));
				});
			}
		}
	}
	close() {
		TestBroadcastChannel.channels.delete(this);
	}
}

describe("useSingleTabGuard", () => {
	let locks: ReturnType<typeof createLockManager>;
	let roots: Root[];
	let mounted: Set<string>;
	let transitions: string[];
	let previousLocks: PropertyDescriptor | undefined;

	function ActiveApp({ id }: { id: string }) {
		useEffect(() => {
			mounted.add(id);
			transitions.push(`mount ${id}`);
			expect(mounted.size).toBe(1);
			return () => {
				mounted.delete(id);
				transitions.push(`unmount ${id}`);
			};
		}, [id]);
		return <div>Active {id}</div>;
	}

	function Tab({ id }: { id: string }) {
		const { isBlocked, forceOpen } = useSingleTabGuard();
		return isBlocked ? (
			<button type="button" onClick={forceOpen}>
				Use here instead
			</button>
		) : (
			<ActiveApp id={id} />
		);
	}

	function mountTab(id: string, strict = false) {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		roots.push(root);
		root.render(
			strict ? (
				<StrictMode>
					<Tab id={id} />
				</StrictMode>
			) : (
				<Tab id={id} />
			),
		);
		return { container, root };
	}

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.stubGlobal("BroadcastChannel", TestBroadcastChannel);
		locks = createLockManager();
		previousLocks = Object.getOwnPropertyDescriptor(navigator, "locks");
		Object.defineProperty(navigator, "locks", { configurable: true, value: locks });
		roots = [];
		mounted = new Set();
		transitions = [];
	});

	afterEach(async () => {
		await act(async () => {
			for (const root of roots) root.unmount();
		});
		document.body.replaceChildren();
		if (previousLocks) Object.defineProperty(navigator, "locks", previousLocks);
		else Reflect.deleteProperty(navigator, "locks");
		vi.unstubAllGlobals();
		vi.useRealTimers();
		sessionStorage.clear();
		expect(TestBroadcastChannel.channels.size).toBe(0);
	});

	it("does not mount the app until ownership is granted", async () => {
		act(() => {
			mountTab("first");
		});
		expect(mounted.size).toBe(0);
		await act(async () => {});
		expect([...mounted]).toEqual(["first"]);
	});

	it("allows only one simultaneous tab even with copied session storage", async () => {
		sessionStorage.setItem("quarterdeck-tab-id", "copied-id");
		await act(async () => {
			mountTab("first");
			mountTab("duplicate");
		});
		expect([...mounted]).toEqual(["first"]);
		expect(transitions).toEqual(["mount first"]);
	});

	it("does not expire ownership when heartbeat timers would have gone stale", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
		await act(async () => {
			mountTab("first");
		});
		await act(async () => {
			vi.advanceTimersByTime(60_000);
			mountTab("second");
		});
		expect([...mounted]).toEqual(["first"]);
	});

	it("unmounts the previous app before a requested takeover mounts the new app", async () => {
		let second!: ReturnType<typeof mountTab>;
		await act(async () => {
			mountTab("first");
			second = mountTab("second");
		});
		await act(async () => {
			second.container.querySelector("button")?.click();
		});
		expect([...mounted]).toEqual(["second"]);
		expect(transitions).toEqual(["mount first", "unmount first", "mount second"]);
	});

	it("moves earlier waiting tabs behind the tab requesting takeover", async () => {
		let third!: ReturnType<typeof mountTab>;
		await act(async () => {
			mountTab("first");
			mountTab("second");
			third = mountTab("third");
		});
		await act(async () => {
			third.container.querySelector("button")?.click();
		});
		expect([...mounted]).toEqual(["third"]);
	});

	it("activates a waiting tab after the owner closes, skipping disposed waiters", async () => {
		let first!: ReturnType<typeof mountTab>;
		let second!: ReturnType<typeof mountTab>;
		await act(async () => {
			first = mountTab("first");
			second = mountTab("second");
			mountTab("third");
		});
		await act(async () => {
			second.root.unmount();
		});
		await act(async () => {
			first.root.unmount();
		});
		expect([...mounted]).toEqual(["third"]);
		expect(transitions).not.toContain("mount second");
	});

	it("reacquires ownership after a pagehide/pageshow instead of reviving an active tree", async () => {
		await act(async () => {
			mountTab("restored");
		});
		await act(async () => {
			window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
		});
		expect(mounted.size).toBe(0);
		await act(async () => {
			mountTab("new-owner");
		});
		await act(async () => {
			window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
		});
		expect([...mounted]).toEqual(["new-owner"]);
	});

	it("cancels the abandoned request during Strict Mode effect replay", async () => {
		await act(async () => {
			mountTab("first", true);
		});
		expect([...mounted]).toEqual(["first"]);
	});
});
