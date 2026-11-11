// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ShellTerminalOperations, shellTerminalScopeKey } from "./shell-terminal-operations";

const home = { projectId: "project-1", taskId: "__home_terminal__" };

describe("ShellTerminalOperations", () => {
	it("invalidates superseded and cancelled intents without affecting another project", () => {
		const operations = new ShellTerminalOperations();
		const old = operations.begin(home);
		const other = operations.begin({ ...home, projectId: "project-2" });
		const latest = operations.begin(home);
		expect(operations.isCurrent(old)).toBe(false);
		expect(old.signal.aborted).toBe(true);
		expect(latest.signal.aborted).toBe(false);
		expect(operations.isCurrent(latest)).toBe(true);
		operations.cancel(home);
		expect(operations.isCurrent(latest)).toBe(false);
		expect(latest.signal.aborted).toBe(true);
		expect(other.signal.aborted).toBe(false);
		expect(operations.isCurrent(other)).toBe(true);
		operations.cancelAll();
		expect(operations.isCurrent(other)).toBe(false);
		expect(other.signal.aborted).toBe(true);
	});

	it("waits for admitted operations in the same scope but not unrelated shells", async () => {
		const operations = new ShellTerminalOperations();
		const calls: string[] = [];
		let finish!: () => void;
		const pending = operations.run(
			home,
			() =>
				new Promise<void>((resolve) => {
					calls.push("start");
					finish = resolve;
				}),
		);
		const stop = operations.run(home, async () => {
			calls.push("stop");
		});
		await operations.run({ ...home, projectId: "project-2" }, async () => {
			calls.push("other");
		});
		expect(calls).toEqual(["start", "other"]);
		finish();
		await Promise.all([pending, stop]);
		expect(calls).toEqual(["start", "other", "stop"]);
	});

	it("preserves a failure for its caller without blocking later explicit intent", async () => {
		const operations = new ShellTerminalOperations();
		const failed = operations.run(home, async () => {
			throw new Error("stop failed");
		});
		const later = operations.run(home, async () => "reattached");
		await expect(failed).rejects.toThrow("stop failed");
		await expect(later).resolves.toBe("reattached");
	});

	it("does not collide when project and task IDs contain separators", () => {
		expect(shellTerminalScopeKey({ projectId: "a:b", taskId: "c" })).not.toBe(
			shellTerminalScopeKey({ projectId: "a", taskId: "b:c" }),
		);
	});
});
