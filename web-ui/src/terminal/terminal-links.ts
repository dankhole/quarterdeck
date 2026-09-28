import { WebLinksAddon } from "@xterm/addon-web-links";
import type { IViewportRange, Terminal } from "@xterm/xterm";
import type { RuntimeAgentId } from "@/runtime/types";
import { isMacPlatform } from "@/utils/platform";

interface HoveredLink {
	uri: string;
	range: IViewportRange;
	confirmNavigation: boolean;
}

/** Own recognized web-link clicks before Codex receives the same mouse gesture. */
export function configureTerminalLinks(
	terminal: Terminal,
	host: HTMLElement,
	callbacks: { getSessionAgentId: () => RuntimeAgentId | null; getConnectedTaskId: () => string | null },
): () => void {
	let hovered: HoveredLink | null = null;
	let pending: { event: MouseEvent; link: HoveredLink; taskId: string | null } | null = null;
	let replaying = false;
	let delegatedDrag = false;
	const document = host.ownerDocument;

	function open(link: Pick<HoveredLink, "uri" | "confirmNavigation">): void {
		if (
			link.confirmNavigation &&
			!window.confirm(`Do you want to navigate to ${link.uri}?\n\nWARNING: This link could potentially be dangerous`)
		)
			return;
		window.open(link.uri, "_blank", "noopener,noreferrer");
	}

	function activate(uri: string, confirmNavigation = false): void {
		if (!delegatedDrag) open({ uri, confirmNavigation });
	}

	function clearPending(): void {
		pending = null;
		document.removeEventListener("mousemove", onMouseMove, true);
		document.removeEventListener("mouseup", onMouseUp, true);
		document.defaultView?.removeEventListener("blur", clearPending);
	}

	function onMouseDown(event: MouseEvent): void {
		if (replaying) return;
		clearPending();
		delegatedDrag = false;
		const forcedSelection = isMacPlatform
			? terminal.options.macOptionClickForcesSelection && event.altKey
			: event.shiftKey;
		if (
			!hovered ||
			event.button !== 0 ||
			forcedSelection ||
			callbacks.getSessionAgentId() !== "codex" ||
			terminal.buffer.active.type !== "alternate" ||
			terminal.modes.mouseTrackingMode === "none"
		)
			return;
		pending = { event, link: hovered, taskId: callbacks.getConnectedTaskId() };
		event.preventDefault();
		event.stopPropagation();
		terminal.focus();
		document.addEventListener("mousemove", onMouseMove, true);
		document.addEventListener("mouseup", onMouseUp, true);
		document.defaultView?.addEventListener("blur", clearPending);
	}

	function onMouseMove(event: MouseEvent): void {
		const gesture = pending;
		if (!(event.buttons & 1)) {
			clearPending();
			return;
		}
		if (!gesture || (event.clientX === gesture.event.clientX && event.clientY === gesture.event.clientY)) return;
		clearPending();
		if (gesture.taskId !== callbacks.getConnectedTaskId() || !host.isConnected) return;
		// Preserve provider selection: replay down before the first drag move through xterm's DOM path.
		delegatedDrag = true;
		replaying = true;
		try {
			gesture.event.target?.dispatchEvent(new MouseEvent("mousedown", gesture.event));
		} finally {
			replaying = false;
		}
	}

	function onMouseUp(event: MouseEvent): void {
		const gesture = pending;
		if (!gesture || event.button !== gesture.event.button) return;
		clearPending();
		event.preventDefault();
		event.stopPropagation();
		if (
			gesture.taskId === callbacks.getConnectedTaskId() &&
			host.isConnected &&
			hovered?.uri === gesture.link.uri &&
			hovered.confirmNavigation === gesture.link.confirmNavigation &&
			hovered.range.start.x === gesture.link.range.start.x &&
			hovered.range.start.y === gesture.link.range.start.y &&
			hovered.range.end.x === gesture.link.range.end.x &&
			hovered.range.end.y === gesture.link.range.end.y &&
			event.clientX === gesture.event.clientX &&
			event.clientY === gesture.event.clientY
		) {
			open(gesture.link);
		}
	}

	terminal.loadAddon(
		new WebLinksAddon((_event, uri) => activate(uri), {
			hover: (_event, uri, range) => {
				hovered = { uri, range, confirmNavigation: false };
			},
			leave: () => {
				hovered = null;
			},
		}),
	);
	terminal.options.linkHandler = {
		activate: (_event, uri) => activate(uri, true),
		hover: (_event, uri, range) => {
			hovered = { uri, range, confirmNavigation: true };
		},
		leave: () => {
			hovered = null;
		},
	};
	host.addEventListener("mousedown", onMouseDown, true);
	return () => {
		clearPending();
		host.removeEventListener("mousedown", onMouseDown, true);
	};
}
