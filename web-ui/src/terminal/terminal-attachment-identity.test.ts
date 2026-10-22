import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlotRenderer } from "@/terminal/slot-renderer";
import { SlotWriteQueue } from "@/terminal/slot-write-queue";
import { TerminalAttachmentController } from "@/terminal/terminal-attachment-controller";
import type { TerminalWriteOptions } from "@/terminal/terminal-write-options";

const { socketInstances, SlotSocketManagerMock } = vi.hoisted(() => {
	interface SocketCallbacks {
		enqueueWrite: (data: string, options?: TerminalWriteOptions) => void;
		onRestore: (snapshot: string, cols: null, rows: null) => Promise<void>;
	}
	class MockSlotSocketManager {
		hasIoSocket = false;
		hasControlSocket = false;
		isIoOpen = false;
		connectionReady = false;
		restoreCompleted = false;
		requiresReconnect = false;
		connectIo = vi.fn();
		connectControl = vi.fn();
		closeAll = vi.fn();
		resetConnectionState = vi.fn();
		sendControl = vi.fn(() => true);
		sendIo = vi.fn(() => true);
		requestRestore = vi.fn();
		constructor(
			_slotId: number,
			_clientId: string,
			readonly callbacks: SocketCallbacks,
		) {
			instances.push(this);
		}
	}
	const instances: MockSlotSocketManager[] = [];
	return { socketInstances: instances, SlotSocketManagerMock: MockSlotSocketManager };
});

vi.mock("@/terminal/slot-socket-manager", () => ({ SlotSocketManager: SlotSocketManagerMock }));

describe("terminal attachment buffer ownership", () => {
	let controller: TerminalAttachmentController;

	beforeEach(() => {
		socketInstances.length = 0;
		// Exercise the real xterm parser and write queue without opening a renderer.
		vi.spyOn(SlotRenderer.prototype, "openWhenFontsReady").mockImplementation(() => {});
		controller = new TerminalAttachmentController(
			1,
			{ cursorColor: "#ffffff", terminalBackgroundColor: "#000000" },
			{ isDisposed: () => false },
		);
		controller.connectToTask("old-task", "project");
	});

	afterEach(() => {
		controller.dispose();
		vi.restoreAllMocks();
	});

	function restore(snapshot: string): Promise<void> {
		return socketInstances[0]!.callbacks.onRestore(snapshot, null, null);
	}

	function output(text: string): void {
		socketInstances[0]!.callbacks.enqueueWrite(text, { batch: true });
	}

	it("clears the old conversation before an immediately reassigned slot receives an empty restore", async () => {
		await restore("OLD CONVERSATION");

		const disconnect = controller.disconnectFromTask();
		controller.connectToTask("new-task", "project");
		await restore("");
		await disconnect;

		expect(controller.connectedTaskId).toBe("new-task");
		expect(controller.readBufferLines()).toEqual([]);
	});

	it("orders pending old output, reset, and new output without erasing the new task", async () => {
		output("OLD PENDING OUTPUT");
		const disconnect = controller.disconnectFromTask();
		controller.connectToTask("new-task", "project");
		output("NEW OUTPUT");
		await restore("");
		await disconnect;

		expect(controller.readBufferLines()).toEqual(["NEW OUTPUT"]);
	});

	it("does not apply an old restore that finishes draining after a different task attaches", async () => {
		let finishDrain: () => void = () => {};
		const draining = new Promise<void>((resolve) => {
			finishDrain = resolve;
		});
		vi.spyOn(SlotWriteQueue.prototype, "drain").mockImplementationOnce(() => draining);
		const oldRestore = restore("OLD DEFERRED RESTORE");
		const disconnect = controller.disconnectFromTask();
		controller.connectToTask("new-task", "project");
		await restore("NEW CONVERSATION");
		finishDrain();
		await oldRestore;
		await disconnect;

		expect(controller.readBufferLines()).toEqual(["NEW CONVERSATION"]);
	});

	it("clears content when directly retargeted to another project", async () => {
		await restore("OLD PROJECT CONVERSATION");
		controller.connectToTask("old-task", "other-project");
		await restore("");

		expect(controller.connectedProjectId).toBe("other-project");
		expect(controller.readBufferLines()).toEqual([]);
	});

	it("preserves the same task's live content when reconnect receives an empty restore", async () => {
		await restore("CURRENT CONVERSATION");
		controller.connectToTask("old-task", "project");
		await restore("");

		expect(controller.readBufferLines()).toEqual(["CURRENT CONVERSATION"]);
	});
});
