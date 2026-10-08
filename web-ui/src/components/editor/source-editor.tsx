import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
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
import {
	createSourceEditorActionContext,
	detectSourceEditorLineSeparator,
	type SourceEditorAction,
	type SourceEditorActionContext,
	type SourceEditorRange,
	sourceEditorOffset,
} from "./source-editor-context";

import { languageExtension, quarterdeckEditorTheme, quarterdeckHighlightStyle } from "./source-presentation";

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
	path: string;
	language: string;
	readOnly: boolean;
	wordWrap: boolean;
	onChange: (value: string) => void;
	onSave?: () => void;
	ignoreUpdateRef: MutableRefObject<boolean>;
	documentVersionRef: MutableRefObject<number>;
	lineSeparator: "\n" | "\r\n";
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
		highlightSelectionMatches(),
		scrollPastEnd(),
		EditorState.lineSeparator.of(input.lineSeparator),
		EditorState.readOnly.of(input.readOnly),
		EditorView.editable.of(!input.readOnly),
		input.wordWrap ? EditorView.lineWrapping : [],
		languageExtension(input.language, input.path) ?? [],
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
	const lineSeparator = useMemo(() => detectSourceEditorLineSeparator(value), [value]);

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
				path,
				language,
				readOnly,
				wordWrap,
				onChange: (nextValue) => onChangeRef.current(nextValue),
				onSave: () => onSaveRef.current?.(),
				ignoreUpdateRef,
				documentVersionRef,
				lineSeparator,
			}),
		[path, language, readOnly, wordWrap, lineSeparator],
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
		view.focus();
		onScrollToRangeConsumed?.();
	}, [path, scrollToRange, onScrollToRangeConsumed]);

	const editor = (
		<div
			ref={hostRef}
			className={cn("min-h-0 flex-1 overflow-hidden", readOnly && "cursor-default")}
			data-testid="source-editor"
			onContextMenu={(event) => {
				const view = viewRef.current;
				if (!view || !actions?.length) return;
				const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
				const selection = view.state.selection.main;
				if (position != null && (selection.empty || position < selection.from || position > selection.to)) {
					view.dispatch({ selection: { anchor: position } });
				}
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
							className="rounded-sm px-2 py-1.5 text-[13px] text-text-primary cursor-pointer outline-none data-[highlighted]:bg-surface-3 data-[disabled]:text-text-tertiary data-[disabled]:cursor-default"
							onSelect={() => {
								const view = viewRef.current;
								if (view)
									action.onSelect(
										createSourceEditorActionContext(view.state, path, documentVersionRef.current),
									);
							}}
						>
							{action.label}
						</ContextMenu.Item>
					))}
				</ContextMenu.Content>
			</ContextMenu.Portal>
		</ContextMenu.Root>
	);
});
