import { HighlightStyle } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

export { languageExtension } from "./source-language-registry";

export const quarterdeckEditorTheme = EditorView.theme(
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

export const quarterdeckHighlightStyle = HighlightStyle.define([
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
