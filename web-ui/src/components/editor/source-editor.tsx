import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import {
	bracketMatching,
	foldGutter,
	foldKeymap,
	HighlightStyle,
	indentOnInput,
	syntaxHighlighting,
} from "@codemirror/language";
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
import { tags } from "@lezer/highlight";
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

export interface SourceEditorProps {
	path: string;
	language: string;
	value: string;
	readOnly: boolean;
	wordWrap: boolean;
	scrollToLine?: number | null;
	onChange: (value: string) => void;
	onSave?: () => void;
	onScrollToLineConsumed?: () => void;
}

export interface SourceEditorHandle {
	openSearchPanel: () => void;
	focus: () => void;
}

export function detectSourceEditorLineSeparator(value: string): "\n" | "\r\n" {
	let crlfCount = 0;
	let lfCount = 0;
	for (let index = value.indexOf("\n"); index >= 0; index = value.indexOf("\n", index + 1)) {
		if (index > 0 && value[index - 1] === "\r") {
			crlfCount++;
		} else {
			lfCount++;
		}
	}
	return crlfCount > lfCount ? "\r\n" : "\n";
}

function languageExtension(language: string, path: string): Extension {
	const lowerPath = path.toLowerCase();
	if (language === "typescript") return javascript({ typescript: true });
	if (language === "tsx") return javascript({ typescript: true, jsx: true });
	if (language === "jsx") return javascript({ jsx: true });
	if (language === "javascript") return javascript();
	if (language === "json") return json();
	if (language === "css") return css();
	if (language === "markdown") return markdown();
	if (language === "python") return python();
	if (language === "java") return java();
	if (language === "cpp" || language === "c") return cpp();
	if (language === "rust") return rust();
	if (language === "sql") return sql();
	if (
		language === "markup" ||
		lowerPath.endsWith(".html") ||
		lowerPath.endsWith(".xml") ||
		lowerPath.endsWith(".svg")
	) {
		return html();
	}
	return [];
}

const quarterdeckEditorTheme = EditorView.theme(
	{
		"&": {
			height: "100%",
			backgroundColor: "var(--color-surface-1)",
			color: "var(--color-text-primary)",
			fontSize: "12px",
		},
		".cm-scroller": {
			fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace',
			lineHeight: "20px",
		},
		".cm-content": {
			caretColor: "var(--color-text-primary)",
			padding: "8px 0 24px",
		},
		".cm-line": {
			padding: "0 16px 0 8px",
		},
		".cm-gutters": {
			backgroundColor: "var(--color-surface-1)",
			borderRight: "1px solid var(--color-border)",
			color: "var(--color-text-tertiary)",
		},
		".cm-activeLine": {
			backgroundColor: "rgba(255, 255, 255, 0.035)",
		},
		".cm-activeLineGutter": {
			backgroundColor: "rgba(255, 255, 255, 0.055)",
			color: "var(--color-text-secondary)",
		},
		".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
			backgroundColor: "rgba(0, 132, 255, 0.76)",
		},
		"&.cm-focused": {
			outline: "none",
		},
		".cm-cursor": {
			borderLeftColor: "var(--color-text-primary)",
		},
		".cm-searchMatch": {
			backgroundColor: "rgba(210, 153, 34, 0.48)",
			outline: "1px solid rgba(210, 153, 34, 0.5)",
		},
		".cm-searchMatch-selected": {
			backgroundColor: "rgba(0, 132, 255, 0.72)",
			outline: "1px solid rgba(255, 255, 255, 0.35)",
		},
		".cm-panels": {
			backgroundColor: "var(--color-surface-2)",
			color: "var(--color-text-secondary)",
			borderColor: "var(--color-border)",
		},
		".cm-panels.cm-panels-top": {
			borderBottom: "1px solid var(--color-border)",
		},
		".cm-panels.cm-panels-bottom": {
			borderTop: "1px solid var(--color-border)",
		},
		".cm-search": {
			alignItems: "center",
			gap: "6px",
			padding: "6px 8px",
			fontSize: "12px",
		},
		".cm-search input": {
			backgroundColor: "var(--color-surface-1)",
			border: "1px solid var(--color-border-bright)",
			borderRadius: "6px",
			color: "var(--color-text-primary)",
			fontSize: "12px",
			padding: "3px 6px",
		},
		".cm-search button": {
			backgroundColor: "var(--color-surface-2)",
			border: "1px solid var(--color-border)",
			borderRadius: "6px",
			color: "var(--color-text-primary)",
			fontSize: "12px",
			minHeight: "24px",
			padding: "3px 8px",
		},
		".cm-search button:hover": {
			color: "var(--color-text-primary)",
			backgroundColor: "var(--color-surface-4)",
			borderColor: "var(--color-border-bright)",
		},
		".cm-search button[name='close']": {
			fontSize: "18px",
			lineHeight: "16px",
			minWidth: "26px",
			padding: "2px 7px",
		},
		".cm-search label": {
			color: "var(--color-text-tertiary)",
		},
	},
	{ dark: true },
);

const quarterdeckHighlightStyle = HighlightStyle.define([
	{ tag: tags.comment, color: "#7A8694", fontStyle: "italic" },
	{ tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword], color: "#C586C0" },
	{ tag: [tags.string, tags.character, tags.attributeValue], color: "#CE9178" },
	{ tag: [tags.number, tags.integer, tags.float, tags.bool, tags.null, tags.atom], color: "#B5CEA8" },
	{ tag: [tags.regexp, tags.escape, tags.special(tags.string)], color: "#D7BA7D" },
	{ tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#DCDCAA" },
	{ tag: [tags.typeName, tags.className, tags.definition(tags.typeName)], color: "#4EC9B0" },
	{ tag: [tags.propertyName, tags.attributeName], color: "#9CDCFE" },
	{ tag: [tags.variableName, tags.definition(tags.variableName), tags.standard(tags.variableName)], color: "#D4D4D4" },
	{ tag: [tags.tagName, tags.angleBracket], color: "#79C0FF" },
	{ tag: [tags.operator, tags.punctuation, tags.bracket], color: "#D4D4D4" },
	{ tag: [tags.heading, tags.strong], color: "#DCDCAA", fontWeight: "600" },
	{ tag: tags.emphasis, fontStyle: "italic" },
	{ tag: tags.link, color: "#4FC1FF", textDecoration: "underline" },
	{ tag: tags.invalid, color: "#F85149", textDecoration: "underline" },
]);

function createExtensions(input: {
	path: string;
	language: string;
	readOnly: boolean;
	wordWrap: boolean;
	onChange: (value: string) => void;
	onSave?: () => void;
	ignoreUpdateRef: MutableRefObject<boolean>;
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
		languageExtension(input.language, input.path),
		EditorView.updateListener.of((update) => {
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
	{ path, language, value, readOnly, wordWrap, scrollToLine, onChange, onSave, onScrollToLineConsumed },
	ref,
): ReactElement {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const viewRef = useRef<EditorView | null>(null);
	const ignoreUpdateRef = useRef(false);
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

	return (
		<div
			ref={hostRef}
			className={cn("min-h-0 flex-1 overflow-hidden", readOnly && "cursor-default")}
			data-testid="source-editor"
		/>
	);
});
