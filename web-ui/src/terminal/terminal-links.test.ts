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

describe.each<RuntimeAgentId>(["codex", "pi"])("%s terminal link gestures", (sessionAgentId) => {
	let terminal: Terminal;
	let agentId: RuntimeAgentId | null;
	let taskId: string;
	let host: HTMLDivElement;
	let target: HTMLSpanElement;
	let disposeLinks: () => void;
	let provider: ILinkProvider;
	let link: Pick<ILink, "activate" | "hover" | "leave"> | undefined;
	const uri = "https://example.com/link";
	const open = vi.fn(() => null);
	const confirm = vi.fn(() => true);
	const downstreamDown = vi.fn();
	const downstreamUp = vi.fn();

	beforeEach(async () => {
		agentId = sessionAgentId;
		taskId = "task-1";
		link = undefined;
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
		target.addEventListener("mouseup", downstreamUp);
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

	async function hover(kind: "detected" | "osc", label = uri): Promise<void> {
		if (kind === "osc") {
			const handler = terminal.options.linkHandler!;
			const range = { start: { x: 1, y: 1 }, end: { x: label.length, y: 1 } };
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
		it(`${kind}: opens once without forwarding the same click to the provider`, async () => {
			await hover(kind);
			pointer("mousedown");
			pointer("mouseup");
			expect(open).toHaveBeenCalledExactlyOnceWith(uri, "_blank", "noopener,noreferrer");
			expect(downstreamDown).not.toHaveBeenCalled();
			expect(downstreamUp).not.toHaveBeenCalled();
		});

		it.each<RuntimeAgentId | null>(["claude", null])(`${kind}: preserves xterm handling for %s`, async (id) => {
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
			link?.leave?.(new MouseEvent("mouseleave"), uri);
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
			link?.leave?.(new MouseEvent("mouseleave"), uri);
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

	it("returns link gestures to xterm during a normal-buffer subprocess and recaptures them on fullscreen return", async () => {
		await write(`\u001b[?1049l${uri}`);
		await hover("detected");
		pointer("mousedown");
		pointer("mouseup");
		expect(downstreamDown).toHaveBeenCalledOnce();
		expect(downstreamUp).toHaveBeenCalledOnce();
		expect(open).toHaveBeenCalledOnce();

		vi.clearAllMocks();
		await write(`\u001b[?1049h${uri}`);
		await hover("detected");
		pointer("mousedown");
		pointer("mouseup");
		expect(downstreamDown).not.toHaveBeenCalled();
		expect(downstreamUp).not.toHaveBeenCalled();
		expect(open).toHaveBeenCalledExactlyOnceWith(uri, "_blank", "noopener,noreferrer");
	});

	it("preserves OSC hyperlink confirmation cancellation in fullscreen", async () => {
		await hover("osc");
		confirm.mockReturnValueOnce(false);
		pointer("mousedown");
		pointer("mouseup");
		expect(confirm).toHaveBeenCalledOnce();
		expect(open).not.toHaveBeenCalled();
		expect(downstreamDown).not.toHaveBeenCalled();
		expect(downstreamUp).not.toHaveBeenCalled();
	});

	it.each([
		{ fullscreen: false, accepted: true },
		{ fullscreen: false, accepted: false },
		{ fullscreen: true, accepted: true },
		{ fullscreen: true, accepted: false },
	])("opens a labeled OSC 8 target only after confirmation: %j", async ({ fullscreen, accepted }) => {
		const label = "Provider documentation";
		await write(
			`${fullscreen ? "" : "\u001b[?1002l\u001b[?1049l"}\u001b[2J\u001b[H\u001b]8;;${uri}\u0007${label}\u001b]8;;\u0007`,
		);
		expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(label);
		const detected = await new Promise<ILink[] | undefined>((resolve) => provider.provideLinks(1, resolve));
		expect(detected ?? []).toHaveLength(0);
		// xterm's OscLinkProvider passes the OSC target URI, not the displayed label,
		// to this public handler. Pointer-to-OSC resolution needs browser functional coverage.
		await hover("osc", label);
		confirm.mockReturnValueOnce(accepted);
		pointer("mousedown");
		pointer("mouseup");
		expect(confirm).toHaveBeenCalledExactlyOnceWith(
			`Do you want to navigate to ${uri}?\n\nWARNING: This link could potentially be dangerous`,
		);
		if (accepted) {
			expect(open).toHaveBeenCalledExactlyOnceWith(uri, "_blank", "noopener,noreferrer");
		} else {
			expect(open).not.toHaveBeenCalled();
		}
		expect(downstreamDown).toHaveBeenCalledTimes(fullscreen ? 0 : 1);
		expect(downstreamUp).toHaveBeenCalledTimes(fullscreen ? 0 : 1);
	});

	it("leaves non-link input with fullscreen mouse tracking to xterm", () => {
		pointer("mousedown");
		pointer("mouseup");
		expect(downstreamDown).toHaveBeenCalledOnce();
		expect(downstreamUp).toHaveBeenCalledOnce();
		expect(confirm).not.toHaveBeenCalled();
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
