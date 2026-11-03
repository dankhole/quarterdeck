import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
	crosshairCursor,
	drawSelection,
	dropCursor,
	EditorView,
	highlightActiveLine,
	highlightActiveLineGutter,
	highlightSpecialChars,
	keymap,
	lineNumbers,
	rectangularSelection,
	scrollPastEnd,
} from "@codemirror/view";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
	forwardRef,
	type MutableRefObject,
	type ReactElement,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
} from "react";

import { cn } from "@/components/ui/cn";
import { Kbd } from "@/components/ui/kbd";
import { useSourceLanguage } from "@/hooks/editor/use-source-language";
import {
	createSourceEditorActionContext,
	detectSourceEditorLineSeparator,
	type SourceEditorAction,
	type SourceEditorActionContext,
	type SourceEditorRange,
	sourceEditorOffset,
} from "./source-editor-context";

import { SOURCE_EDITOR_NAVIGATION_SHORTCUTS, sourceEditorNavigation } from "./source-editor-navigation";
import { quarterdeckEditorTheme, quarterdeckHighlightStyle } from "./source-presentation";

const noLanguage: Extension = [];

export type { SourceEditorAction, SourceEditorActionContext, SourceEditorRange } from "./source-editor-context";
export { detectSourceEditorLineSeparator } from "./source-editor-context";

export interface SourceEditorProps {
	path: string;
	language: string;
	value: string;
	readOnly: boolean;
	wordWrap: boolean;
	scrollToLine?: number | null;
	scrollToRange?: SourceEditorRange | null;
	/** Results previews reveal a range without taking focus from the usages list. */
	focusOnScrollToRange?: boolean;
	actions?: readonly SourceEditorAction[];
	onScrollToRangeConsumed?: () => void;
	onChange: (value: string) => void;
	onSave?: () => void;
	onScrollToLineConsumed?: () => void;
}

export interface SourceEditorHandle {
	openSearchPanel: () => void;
	focus: () => void;
	getActionContext: () => SourceEditorActionContext | null;
}

function createExtensions(input: {
	languageExtension: Extension;
	readOnly: boolean;
	wordWrap: boolean;
	onChange: (value: string) => void;
	onSave?: () => void;
	ignoreUpdateRef: MutableRefObject<boolean>;
	documentVersionRef: MutableRefObject<number>;
	lineSeparator: "\n" | "\r\n";
	navigation: Extension;
}): Extension[] {
	return [
		quarterdeckEditorTheme,
		lineNumbers(),
		highlightActiveLineGutter(),
		highlightSpecialChars(),
		history(),
		foldGutter(),
		drawSelection(),
		dropCursor(),
		EditorState.allowMultipleSelections.of(true),
		indentOnInput(),
		syntaxHighlighting(quarterdeckHighlightStyle),
		bracketMatching(),
		search({ top: true }),
		rectangularSelection(),
		crosshairCursor(),
		highlightActiveLine(),
		// Lexical whole-word matches, not semantic language-server references.
		highlightSelectionMatches({ highlightWordAroundCursor: true }),
		scrollPastEnd(),
		EditorState.lineSeparator.of(input.lineSeparator),
		EditorState.readOnly.of(input.readOnly),
		EditorView.editable.of(!input.readOnly),
		input.readOnly ? EditorView.contentAttributes.of({ tabindex: "0" }) : [],
		input.navigation,
		input.wordWrap ? EditorView.lineWrapping : [],
		input.languageExtension,
		EditorView.updateListener.of((update) => {
			if (update.docChanged) input.documentVersionRef.current += 1;
			if (!update.docChanged || input.ignoreUpdateRef.current) {
				return;
			}
			input.onChange(update.state.sliceDoc());
		}),
		keymap.of([
			{
				key: "Mod-s",
				preventDefault: true,
				run: () => {
					input.onSave?.();
					return true;
				},
			},
			...searchKeymap,
			...foldKeymap,
			...historyKeymap,
			...defaultKeymap,
		]),
	];
}

export const SourceEditor = forwardRef<SourceEditorHandle, SourceEditorProps>(function SourceEditor(
	{
		path,
		language,
		value,
		readOnly,
		wordWrap,
		scrollToLine,
		scrollToRange,
		focusOnScrollToRange = true,
		actions,
		onChange,
		onSave,
		onScrollToLineConsumed,
		onScrollToRangeConsumed,
	},
	ref,
): ReactElement {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const viewRef = useRef<EditorView | null>(null);
	const ignoreUpdateRef = useRef(false);
	const documentVersionRef = useRef(1);
	const pathRef = useRef(path);
	pathRef.current = path;
	const onChangeRef = useRef(onChange);
	const onSaveRef = useRef(onSave);
	const actionsRef = useRef(actions);
	actionsRef.current = actions;
	const menuContextRef = useRef<SourceEditorActionContext | null>(null);
	const lineSeparator = useMemo(() => detectSourceEditorLineSeparator(value), [value]);
	const sourceLanguage = useSourceLanguage(language, path);
	const languageCompartment = useMemo(() => new Compartment(), []);

	useEffect(() => {
		onChangeRef.current = onChange;
	}, [onChange]);

	useEffect(() => {
		onSaveRef.current = onSave;
	}, [onSave]);

	useImperativeHandle(
		ref,
		() => ({
			openSearchPanel: () => {
				const view = viewRef.current;
				if (!view) return;
				openSearchPanel(view);
				view.focus();
			},
			getActionContext: () =>
				viewRef.current
					? createSourceEditorActionContext(viewRef.current.state, pathRef.current, documentVersionRef.current)
					: null,
			focus: () => {
				viewRef.current?.focus();
			},
		}),
		[],
	);

	const extensions = useMemo(
		() =>
			createExtensions({
				languageExtension: languageCompartment.of(noLanguage),
				readOnly,
				wordWrap,
				onChange: (nextValue) => onChangeRef.current(nextValue),
				onSave: () => onSaveRef.current?.(),
				ignoreUpdateRef,
				documentVersionRef,
				lineSeparator,
				navigation: sourceEditorNavigation({
					isEnabled: (id) => actionsRef.current?.some((action) => action.id === id && !action.disabled) ?? false,
					run: (id, view, position) => {
						const action = actionsRef.current?.find((candidate) => candidate.id === id);
						if (!action || action.disabled) return false;
						action.onSelect(
							createSourceEditorActionContext(view.state, pathRef.current, documentVersionRef.current, position),
						);
						return true;
					},
				}),
			}),
		[path, readOnly, wordWrap, lineSeparator, languageCompartment],
	);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;

		const view = new EditorView({
			parent: host,
			state: EditorState.create({
				doc: value,
				extensions,
			}),
		});
		viewRef.current = view;
		return () => {
			view.destroy();
			if (viewRef.current === view) {
				viewRef.current = null;
			}
		};
	}, [extensions]);

	useEffect(() => {
		const view = viewRef.current;
		if (!view || pathRef.current !== path) return;
		const nextLanguage = sourceLanguage ?? noLanguage;
		// The hook owns async loading and stale-result rejection. Apply only to the
		// current view, without replacing its document, history, or selection.
		if (languageCompartment.get(view.state) !== nextLanguage) {
			view.dispatch({ effects: languageCompartment.reconfigure(nextLanguage) });
		}
	}, [sourceLanguage, languageCompartment, extensions, path]);

	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		const currentValue = view.state.sliceDoc();
		if (currentValue === value) return;
		ignoreUpdateRef.current = true;
		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: value },
		});
		ignoreUpdateRef.current = false;
	}, [value]);

	useEffect(() => {
		const view = viewRef.current;
		if (!view || scrollToLine == null) return;
		const targetLine = Math.max(1, Math.min(scrollToLine, view.state.doc.lines));
		const position = view.state.doc.line(targetLine).from;
		view.dispatch({
			selection: { anchor: position },
			effects: EditorView.scrollIntoView(position, { y: "center" }),
		});
		onScrollToLineConsumed?.();
	}, [scrollToLine, onScrollToLineConsumed]);

	useEffect(() => {
		const view = viewRef.current;
		if (!view || !scrollToRange) return;
		const anchor = sourceEditorOffset(view.state, scrollToRange.start);
		const head = sourceEditorOffset(view.state, scrollToRange.end);
		view.dispatch({
			selection: { anchor, head },
			effects: EditorView.scrollIntoView(anchor, { y: "center" }),
		});
		if (focusOnScrollToRange) view.focus();
		onScrollToRangeConsumed?.();
	}, [path, scrollToRange, focusOnScrollToRange, onScrollToRangeConsumed]);

	const editor = (
		<div
			ref={hostRef}
			className={cn("min-h-0 flex-1 overflow-hidden", readOnly && "cursor-default")}
			data-testid="source-editor"
			onContextMenuCapture={(event) => {
				const view = viewRef.current;
				menuContextRef.current = null;
				if (!view || !actions?.length) return;
				// Capture before Radix opens the menu and moves focus. Keyboard context
				// menus have no pointer coordinates and should use the existing caret.
				const keyboard = event.button === 0 && event.clientX === 0 && event.clientY === 0;
				const position = keyboard
					? view.state.selection.main.head
					: view.posAtCoords({ x: event.clientX, y: event.clientY });
				if (position === null) {
					event.preventDefault();
					return;
				}
				const insideSelection = view.state.selection.ranges.some(
					(selection) => !selection.empty && position >= selection.from && position < selection.to,
				);
				if (!keyboard && !insideSelection) {
					view.dispatch({ selection: { anchor: position } });
				}
				menuContextRef.current = createSourceEditorActionContext(
					view.state,
					path,
					documentVersionRef.current,
					position,
				);
			}}
		/>
	);
	return (
		<ContextMenu.Root>
			<ContextMenu.Trigger asChild disabled={!actions?.length}>
				{editor}
			</ContextMenu.Trigger>
			<ContextMenu.Portal>
				<ContextMenu.Content className="z-50 min-w-48 rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg">
					{actions?.map((action) => (
						<ContextMenu.Item
							key={action.id}
							disabled={action.disabled}
							className="flex items-center justify-between gap-6 rounded-sm px-2 py-1.5 text-[13px] text-text-primary cursor-pointer outline-none data-[highlighted]:bg-surface-3 data-[disabled]:text-text-tertiary data-[disabled]:cursor-default"
							onSelect={() => {
								const context = menuContextRef.current;
								const view = viewRef.current;
								if (
									!action.disabled &&
									context &&
									view &&
									context.path === path &&
									context.documentVersion === documentVersionRef.current
								) {
									action.onSelect(context);
								}
							}}
						>
							<span>{action.label}</span>
							{SOURCE_EDITOR_NAVIGATION_SHORTCUTS[action.id] && (
								<Kbd>{SOURCE_EDITOR_NAVIGATION_SHORTCUTS[action.id]}</Kbd>
							)}
						</ContextMenu.Item>
					))}
				</ContextMenu.Content>
			</ContextMenu.Portal>
		</ContextMenu.Root>
	);
});
