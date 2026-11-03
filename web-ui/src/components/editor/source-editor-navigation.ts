import type { Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { isMacPlatform } from "@/utils/platform";

export const SOURCE_EDITOR_NAVIGATION_SHORTCUTS: Readonly<Record<string, string>> = {
	"code-navigation-definition": isMacPlatform ? "⌘B" : "Ctrl+B",
	"code-navigation-references": "Alt+F7",
	"code-navigation-hover": isMacPlatform ? "Ctrl+J" : "Ctrl+Q",
};

/** Reuses the supplied actions; neither shortcuts nor gestures grant navigation authority. */
export function sourceEditorNavigation(input: {
	isEnabled: (id: string) => boolean;
	run: (id: string, view: EditorView, position?: number) => boolean;
}): Extension {
	let pointer: { x: number; y: number } | null = null;
	const definition = "code-navigation-definition";
	const hasNavigationModifier = (event: MouseEvent | KeyboardEvent) =>
		(isMacPlatform ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
		!event.shiftKey &&
		!event.altKey;
	const positionAtPointer = (view: EditorView) => {
		if (!pointer || !input.isEnabled(definition)) return null;
		const position = view.posAtCoords(pointer);
		return position !== null && view.state.wordAt(position) ? position : null;
	};
	const showPointer = (view: EditorView, show: boolean) => {
		view.contentDOM.toggleAttribute("data-definition-link", show);
	};

	return [
		keymap.of([
			{ key: isMacPlatform ? "Meta-b" : "Ctrl-b", run: (view) => input.run(definition, view) },
			{ key: "Alt-F7", run: (view) => input.run("code-navigation-references", view) },
			{
				key: isMacPlatform ? "Ctrl-j" : "Ctrl-q",
				run: (view) => input.run("code-navigation-hover", view),
			},
		]),
		EditorView.domEventHandlers({
			mousemove: (event, view) => {
				pointer = { x: event.clientX, y: event.clientY };
				showPointer(view, hasNavigationModifier(event) && positionAtPointer(view) !== null);
			},
			mouseleave: (_event, view) => {
				pointer = null;
				showPointer(view, false);
			},
			keydown: (event, view) => {
				showPointer(view, hasNavigationModifier(event) && positionAtPointer(view) !== null);
			},
			keyup: (event, view) => {
				showPointer(view, hasNavigationModifier(event) && positionAtPointer(view) !== null);
			},
			blur: (_event, view) => showPointer(view, false),
			mousedown: (event, view) => {
				if (event.button !== 0 || !hasNavigationModifier(event)) return false;
				pointer = { x: event.clientX, y: event.clientY };
				const position = positionAtPointer(view);
				if (position === null) return false;
				// Handle only the explicit navigation gesture. Shift/Alt clicks, normal
				// selection, right-click, and clicks without an available action stay native.
				const handled = input.run(definition, view, position);
				if (handled) showPointer(view, false);
				return handled;
			},
		}),
	];
}
