const PARKING_ROOT_ID = "kb-persistent-terminal-parking-root";
const XTERM_ROOT_SELECTOR = ".xterm";
const XTERM_HELPER_TEXTAREA_SELECTOR = "textarea.xterm-helper-textarea";

type TerminalDiagnosticsRoot = Document | DocumentFragment | Element;

export interface TerminalHelperTextareaDiagnostic {
	index: number;
	id: string;
	name: string;
	hasId: boolean;
	hasName: boolean;
	isConnected: boolean;
	inParkingRoot: boolean;
	closestXterm: string | null;
	parentPath: string;
}

export interface TerminalParkingRootDiagnostic {
	childElementCount: number;
	helperTextareaCount: number;
	xtermElementCount: number;
	children: TerminalParkingRootChildDiagnostic[];
}

export interface TerminalParkingRootChildDiagnostic {
	index: number;
	childElementCount: number;
	helperTextareaCount: number;
	xtermElementCount: number;
	visibility: string;
	parentPath: string;
}

export interface TerminalDomDiagnostics {
	helperTextareaCount: number;
	helperTextareasMissingId: number;
	helperTextareasMissingName: number;
	xtermElementCount: number;
	parkingRoot: TerminalParkingRootDiagnostic | null;
	helperTextareas: TerminalHelperTextareaDiagnostic[];
}

function describeElement(element: Element): string {
	const tagName = element.tagName.toLowerCase();
	const id = element.id ? `#${element.id}` : "";
	const classes = Array.from(element.classList)
		.slice(0, 4)
		.map((className) => `.${className}`)
		.join("");
	return `${tagName}${id}${classes}`;
}

function describeParentPath(element: Element, maxDepth = 10): string {
	const parts: string[] = [];
	let current: Element | null = element;
	for (let depth = 0; current && depth < maxDepth; depth += 1) {
		parts.push(describeElement(current));
		if (current.id === PARKING_ROOT_ID) {
			break;
		}
		current = current.parentElement;
	}
	return parts.join(" <- ");
}

function summarizeParkingRootChild(element: Element, index: number): TerminalParkingRootChildDiagnostic {
	return {
		index,
		childElementCount: element.childElementCount,
		helperTextareaCount: element.querySelectorAll(XTERM_HELPER_TEXTAREA_SELECTOR).length,
		xtermElementCount: element.querySelectorAll(XTERM_ROOT_SELECTOR).length,
		visibility: element instanceof HTMLElement ? element.style.visibility : "",
		parentPath: describeParentPath(element, 3),
	};
}

function summarizeHelperTextarea(
	textarea: HTMLTextAreaElement,
	index: number,
	parkingRoot: HTMLElement | null,
): TerminalHelperTextareaDiagnostic {
	const closestXterm = textarea.closest(XTERM_ROOT_SELECTOR);
	return {
		index,
		id: textarea.id,
		name: textarea.name,
		hasId: textarea.id.length > 0,
		hasName: textarea.name.length > 0,
		isConnected: textarea.isConnected,
		inParkingRoot: parkingRoot?.contains(textarea) ?? false,
		closestXterm: closestXterm ? describeElement(closestXterm) : null,
		parentPath: describeParentPath(textarea),
	};
}

export function collectTerminalDomDiagnostics(root: TerminalDiagnosticsRoot = document): TerminalDomDiagnostics {
	const helperTextareas = Array.from(root.querySelectorAll<HTMLTextAreaElement>(XTERM_HELPER_TEXTAREA_SELECTOR));
	const xtermElements = root.querySelectorAll(XTERM_ROOT_SELECTOR);
	const parkingRoot = document.getElementById(PARKING_ROOT_ID);
	const parkingRootDiagnostic =
		parkingRoot instanceof HTMLElement
			? {
					childElementCount: parkingRoot.childElementCount,
					helperTextareaCount: parkingRoot.querySelectorAll(XTERM_HELPER_TEXTAREA_SELECTOR).length,
					xtermElementCount: parkingRoot.querySelectorAll(XTERM_ROOT_SELECTOR).length,
					children: Array.from(parkingRoot.children).map(summarizeParkingRootChild),
				}
			: null;
	const helperDiagnostics = helperTextareas.map((textarea, index) =>
		summarizeHelperTextarea(textarea, index, parkingRoot instanceof HTMLElement ? parkingRoot : null),
	);

	return {
		helperTextareaCount: helperTextareas.length,
		helperTextareasMissingId: helperDiagnostics.filter((helper) => !helper.hasId).length,
		helperTextareasMissingName: helperDiagnostics.filter((helper) => !helper.hasName).length,
		xtermElementCount: xtermElements.length,
		parkingRoot: parkingRootDiagnostic,
		helperTextareas: helperDiagnostics,
	};
}
