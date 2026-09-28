import { type ILink, type ILinkProvider, Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeAgentId } from "@/runtime/types";
import { configureTerminalLinks } from "@/terminal/terminal-links";

const platform = vi.hoisted(() => ({ isMac: true }));
vi.mock("@/utils/platform", () => ({
	get isMacPlatform() {
		return platform.isMac;
	},
}));

describe("terminal link gestures", () => {
	let terminal: Terminal;
	let agentId: RuntimeAgentId | null;
	let taskId: string;
	let host: HTMLDivElement;
	let target: HTMLSpanElement;
	let disposeLinks: () => void;
	let provider: ILinkProvider;
	let link: Pick<ILink, "activate" | "hover" | "leave">;
	const uri = "https://example.com/link";
	const open = vi.fn(() => null);
	const confirm = vi.fn(() => true);
	const downstreamDown = vi.fn();

	beforeEach(async () => {
		agentId = "codex";
		taskId = "task-1";
		platform.isMac = true;
		terminal = new Terminal({ allowProposedApi: true, macOptionClickForcesSelection: true });
		const registration = vi.spyOn(terminal, "registerLinkProvider");
		host = document.createElement("div");
		target = document.createElement("span");
		host.append(target);
		document.body.append(host);
		disposeLinks = configureTerminalLinks(terminal, host, {
			getSessionAgentId: () => agentId,
			getConnectedTaskId: () => taskId,
		});
		provider = registration.mock.calls[0]![0];
		vi.spyOn(window, "open").mockImplementation(open);
		vi.spyOn(window, "confirm").mockImplementation(confirm);
		target.addEventListener("mousedown", downstreamDown);
		target.addEventListener("mouseup", (event) => link?.activate(event, uri));
		await write(`\u001b[?1049h\u001b[?1002h${uri}`);
	});

	afterEach(() => {
		disposeLinks();
		terminal.dispose();
		host.remove();
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	function write(text: string): Promise<void> {
		return new Promise((resolve) => terminal.write(text, resolve));
	}

	function pointer(type: string, init: MouseEventInit = {}): MouseEvent {
		const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: 10, ...init });
		target.dispatchEvent(event);
		return event;
	}

	async function hover(kind: "detected" | "osc"): Promise<void> {
		if (kind === "osc") {
			const handler = terminal.options.linkHandler!;
			const range = { start: { x: 1, y: 1 }, end: { x: 24, y: 1 } };
			link = {
				activate: (event, text) => handler.activate(event, text, range),
				hover: (event, text) => handler.hover?.(event, text, range),
				leave: (event, text) => handler.leave?.(event, text, range),
			};
		} else {
			const links = await new Promise<ILink[] | undefined>((resolve) => provider.provideLinks(1, resolve));
			expect(links).toHaveLength(1);
			link = links![0]!;
		}
		link.hover?.(new MouseEvent("mousemove"), uri);
	}

	for (const kind of ["detected", "osc"] as const) {
		it(`${kind}: opens once without forwarding the same click to Codex`, async () => {
			await hover(kind);
			pointer("mousedown");
			pointer("mouseup");
			expect(open).toHaveBeenCalledExactlyOnceWith(uri, "_blank", "noopener,noreferrer");
			expect(downstreamDown).not.toHaveBeenCalled();
		});

		it.each<RuntimeAgentId | null>(["claude", "pi", null])(`${kind}: preserves xterm handling for %s`, async (id) => {
			agentId = id;
			await hover(kind);
			pointer("mousedown");
			pointer("mouseup");
			expect(downstreamDown).toHaveBeenCalledOnce();
			expect(open).toHaveBeenCalledOnce();
		});

		it.each(["\u001b[?1002l", `\u001b[?1049l${uri}`])(
			`${kind}: leaves non-fullscreen input to xterm: %j`,
			async (sequence) => {
				await write(sequence);
				await hover(kind);
				pointer("mousedown");
				pointer("mouseup");
				expect(downstreamDown).toHaveBeenCalledOnce();
				expect(open).toHaveBeenCalledOnce();
			},
		);

		it.each([
			{ isMac: true, modifier: { altKey: true } },
			{ isMac: false, modifier: { shiftKey: true } },
		])(`${kind}: preserves ownership across modifier changes: %j`, async ({ isMac, modifier }) => {
			platform.isMac = isMac;
			await hover(kind);
			pointer("mousedown", modifier);
			pointer("mouseup");
			expect(downstreamDown).toHaveBeenCalledOnce();
			expect(open).toHaveBeenCalledOnce();
			vi.clearAllMocks();
			pointer("mousedown");
			pointer("mouseup", modifier);
			expect(downstreamDown).not.toHaveBeenCalled();
			expect(open).toHaveBeenCalledOnce();
		});

		it(`${kind}: replays down before a drag and suppresses browser activation on release`, async () => {
			await hover(kind);
			pointer("mousedown", { ctrlKey: true });
			expect(downstreamDown).not.toHaveBeenCalled();
			pointer("mousemove", { clientX: 20, buttons: 1 });
			expect(downstreamDown).toHaveBeenCalledOnce();
			expect(downstreamDown.mock.calls[0]![0]).toMatchObject({ clientX: 10, ctrlKey: true });
			pointer("mouseup");
			expect(open).not.toHaveBeenCalled();
			pointer("mousedown");
			pointer("mouseup");
			expect(open).toHaveBeenCalledOnce();
		});

		it(`${kind}: survives re-hover of the same link after a redraw`, async () => {
			await hover(kind);
			pointer("mousedown");
			link.leave?.(new MouseEvent("mouseleave"), uri);
			await hover(kind);
			pointer("mouseup");
			expect(open).toHaveBeenCalledOnce();
		});

		it.each(["buttons", "blur"])(`${kind}: cancels a lost release on %s`, async (reason) => {
			await hover(kind);
			pointer("mousedown");
			if (reason === "blur") window.dispatchEvent(new Event("blur"));
			pointer("mousemove", { clientX: 20, buttons: 0 });
			expect(downstreamDown).not.toHaveBeenCalled();
			expect(open).not.toHaveBeenCalled();
		});

		it(`${kind}: does not open a link that vanished during the click`, async () => {
			await hover(kind);
			pointer("mousedown");
			link.leave?.(new MouseEvent("mouseleave"), uri);
			pointer("mouseup");
			expect(open).not.toHaveBeenCalled();
		});

		it.each(["mouseup", "mousemove"])(
			`${kind}: cancels pending input when the pooled task changes before %s`,
			async (type) => {
				await hover(kind);
				pointer("mousedown");
				taskId = "task-2";
				pointer(type, type === "mousemove" ? { clientX: 20, buttons: 1 } : {});
				expect(open).not.toHaveBeenCalled();
				expect(downstreamDown).not.toHaveBeenCalled();
			},
		);
	}

	it("preserves OSC hyperlink confirmation cancellation in fullscreen Codex", async () => {
		await hover("osc");
		confirm.mockReturnValueOnce(false);
		pointer("mousedown");
		pointer("mouseup");
		expect(confirm).toHaveBeenCalledOnce();
		expect(open).not.toHaveBeenCalled();
	});

	it("removes document gesture listeners on disposal", async () => {
		await hover("detected");
		pointer("mousedown");
		disposeLinks();
		document.dispatchEvent(new MouseEvent("mouseup", { clientX: 10, clientY: 10 }));
		expect(open).not.toHaveBeenCalled();
	});
});
