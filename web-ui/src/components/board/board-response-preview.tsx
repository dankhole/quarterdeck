import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/components/ui/cn";

const REMARK_PLUGINS = [remarkGfm];
const HEADING_CLASS_NAME = "m-0 text-[12px] font-semibold leading-[18px]";
const CELL_CLASS_NAME = "p-0 pr-2 text-left align-top";

// Only parser-produced Markdown elements are admitted. URL-bearing elements and
// GFM checkboxes render as inert text; no source props are spread onto the DOM.
const PREVIEW_ELEMENTS = [
	"p",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"strong",
	"em",
	"del",
	"a",
	"img",
	"ul",
	"ol",
	"li",
	"blockquote",
	"pre",
	"code",
	"table",
	"thead",
	"tbody",
	"tr",
	"th",
	"td",
	"hr",
	"br",
	"input",
];

const PREVIEW_COMPONENTS: Components = {
	p: ({ children }) => <p className="m-0">{children}</p>,
	h1: ({ children }) => <h1 className={HEADING_CLASS_NAME}>{children}</h1>,
	h2: ({ children }) => <h2 className={HEADING_CLASS_NAME}>{children}</h2>,
	h3: ({ children }) => <h3 className={HEADING_CLASS_NAME}>{children}</h3>,
	h4: ({ children }) => <h4 className={HEADING_CLASS_NAME}>{children}</h4>,
	h5: ({ children }) => <h5 className={HEADING_CLASS_NAME}>{children}</h5>,
	h6: ({ children }) => <h6 className={HEADING_CLASS_NAME}>{children}</h6>,
	a: ({ children }) => <span>{children}</span>,
	img: ({ alt }) => <span>{alt}</span>,
	input: ({ checked }) => <span>{checked ? "[x]" : "[ ]"}</span>,
	ul: ({ children }) => <ul className="m-0 list-disc pl-4">{children}</ul>,
	ol: ({ children, start }) => (
		<ol className="m-0 list-decimal pl-4" start={start}>
			{children}
		</ol>
	),
	li: ({ children }) => <li className="m-0 p-0">{children}</li>,
	blockquote: ({ children }) => (
		<blockquote className="m-0 border-l-2 border-border-bright pl-2">{children}</blockquote>
	),
	pre: ({ children }) => (
		<pre className="m-0 whitespace-pre-wrap font-mono text-[12px] leading-[18px]">{children}</pre>
	),
	code: ({ children }) => (
		<code className="whitespace-pre-wrap rounded-sm bg-surface-2 font-mono text-[12px] leading-[18px]">
			{children}
		</code>
	),
	table: ({ children }) => (
		<table className="m-0 w-full table-fixed border-collapse text-[12px] leading-[18px]">{children}</table>
	),
	th: ({ children }) => <th className={cn(CELL_CLASS_NAME, "font-semibold")}>{children}</th>,
	td: ({ children }) => <td className={CELL_CLASS_NAME}>{children}</td>,
	hr: () => <hr className="m-0 border-border" />,
};

export function BoardResponsePreview({ text, className }: { text: string; className?: string }): React.ReactElement {
	return (
		<div
			data-board-response-preview
			className={cn(
				// Clamp the whole preview, not each nested Markdown block independently.
				"max-h-[108px] min-w-0 overflow-hidden text-[12px] leading-[18px] [overflow-wrap:anywhere]",
				className,
			)}
		>
			<Markdown
				remarkPlugins={REMARK_PLUGINS}
				allowedElements={PREVIEW_ELEMENTS}
				components={PREVIEW_COMPONENTS}
				skipHtml
			>
				{text.slice(0, 500)}
			</Markdown>
		</div>
	);
}
