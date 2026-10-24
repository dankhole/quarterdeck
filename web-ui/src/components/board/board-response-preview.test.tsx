import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardResponsePreview } from "@/components/board/board-response-preview";

describe("BoardResponsePreview", () => {
	let root: Root;
	let container: HTMLDivElement;

	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
	});

	async function render(text: string, className?: string): Promise<HTMLElement> {
		await act(async () => root.render(<BoardResponsePreview text={text} className={className} />));
		return container.querySelector<HTMLElement>("[data-board-response-preview]")!;
	}

	it("parses headings, emphasis, nested lists, quotes, and code without full-document styling", async () => {
		const preview = await render(
			[
				"## Ready",
				"",
				"**Changed** _carefully_ with `inline code` and ~~old text~~.",
				"",
				"- First item",
				"  - Nested item",
				"",
				"3. Ordered item",
				"",
				"> A compact quote",
				"",
				"```ts",
				"const result = true;",
				"```",
			].join("\n"),
			"text-text-secondary",
		);

		expect(preview.querySelector("h2")?.textContent).toBe("Ready");
		expect(preview.querySelector("strong")?.textContent).toBe("Changed");
		expect(preview.querySelector("em")?.textContent).toBe("carefully");
		expect(preview.querySelector("del")?.textContent).toBe("old text");
		expect(preview.querySelector("p code")?.textContent).toBe("inline code");
		expect(preview.querySelector("ul > li > ul > li")?.textContent).toBe("Nested item");
		expect(preview.querySelector("ol")?.getAttribute("start")).toBe("3");
		expect(preview.querySelector("blockquote p")?.textContent).toBe("A compact quote");
		expect(preview.querySelector("pre code")?.textContent).toBe("const result = true;\n");
		expect(preview.classList.contains("text-text-secondary")).toBe(true);
		expect(preview.querySelector(".kb-markdown-rendered")).toBeNull();
		expect(preview.classList.contains("kb-markdown-rendered")).toBe(false);
	});

	it("keeps list markers and blocks compact within one six-line hard height bound", async () => {
		const preview = await render(
			"# Heading\n\nParagraph\n\n- One\n\n- Two\n  - Nested\n\n> Quote\n\n```\ncode\n```\n\nLast paragraph",
		);

		// jsdom cannot measure layout. These assert the CSS contract; browser
		// validation must check the actual clipping across these nested blocks.
		for (const className of [
			"max-h-[108px]",
			"min-w-0",
			"overflow-hidden",
			"text-[12px]",
			"leading-[18px]",
			"[overflow-wrap:anywhere]",
		]) {
			expect(preview.classList.contains(className)).toBe(true);
		}
		expect(preview.querySelector("ul")?.classList.contains("list-disc")).toBe(true);
		expect(preview.querySelector("ul")?.classList.contains("pl-4")).toBe(true);
		for (const element of preview.querySelectorAll("p, h1, ul, li, blockquote, pre")) {
			expect(element.classList.contains("m-0")).toBe(true);
		}
		expect(preview.querySelector("[class*=line-clamp]")).toBeNull();
	});

	it("renders GFM table cells and task states without checkbox controls", async () => {
		const preview = await render(
			"| Change | State |\n|:---|---:|\n| **Parser** | `done` |\n\n- [x] Completed\n- [ ] Remaining",
		);

		expect([...preview.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual(["Change", "State"]);
		expect([...preview.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual(["Parser", "done"]);
		expect(preview.querySelector("td strong")).not.toBeNull();
		expect(preview.querySelector("td code")).not.toBeNull();
		expect(preview.textContent).toContain("[x] Completed");
		expect(preview.textContent).toContain("[ ] Remaining");
		expect(preview.querySelector("input, button, [role=checkbox]")).toBeNull();
		expect(preview.querySelector("table")?.classList.contains("table-fixed")).toBe(true);
		expect(preview.querySelector("table")?.classList.contains("w-full")).toBe(true);
	});

	it("wraps long unbroken text, fenced code, and fixed-width table cells", async () => {
		const word = "x".repeat(100);
		const preview = await render(`${word}\n\n\`\`\`\n${word}\n\`\`\`\n\n| Value |\n|---|\n| ${word} |`);

		expect(preview.classList.contains("[overflow-wrap:anywhere]")).toBe(true);
		expect(preview.querySelector("pre")?.classList.contains("whitespace-pre-wrap")).toBe(true);
		expect(preview.querySelector("code")?.classList.contains("whitespace-pre-wrap")).toBe(true);
		expect(preview.querySelector("pre code")?.textContent).toBe(`${word}\n`);
		expect(preview.querySelector("td")?.textContent).toBe(word);
		expect(preview.querySelector("[class*=overflow-auto], [class*=overflow-x-auto]")).toBeNull();
	});

	it.each([
		"https://remote.example/path",
		"javascript:alert(1)",
		"vbscript:msgbox(1)",
		"data:text/html,unsafe",
		"file:///etc/passwd",
		"/relative/path",
		"#section",
	])("keeps %s links inert while preserving their readable label", async (url) => {
		const preview = await render(`[**Readable label**](${url} "title")`);

		expect(preview.textContent).toBe("Readable label");
		expect(preview.querySelector("strong")?.textContent).toBe("Readable label");
		expect(preview.querySelector("a, [href], [tabindex], [onclick]")).toBeNull();
	});

	it("makes autolinks and reference links inert and leaves footnote-like text harmless", async () => {
		const preview = await render(
			"<https://remote.example/a> www.remote.example <person@example.com> [Reference][ref] [^note]\n\n[ref]: /target\n[^note]: Footnote text",
		);

		expect(preview.textContent).toContain("https://remote.example/a");
		expect(preview.textContent).toContain("www.remote.example");
		expect(preview.textContent).toContain("person@example.com");
		expect(preview.textContent).toContain("Reference");
		expect(preview.querySelector("a, [href], [id], [tabindex]")).toBeNull();
	});

	it("preserves image alt text without mounting images or exposing request URLs", async () => {
		const preview = await render(
			"![Readable **diagram**](https://remote.example/tracking.png) [![Linked diagram](//remote.example/linked.png)](https://remote.example) ![](data:image/svg+xml,unsafe)",
		);

		expect(preview.textContent).toContain("Readable diagram");
		expect(preview.textContent).toContain("Linked diagram");
		expect(preview.querySelector("img, picture, source, a, [src], [srcset], [href]")).toBeNull();
		expect(preview.innerHTML).not.toContain("remote.example");
		expect(preview.innerHTML).not.toContain("data:image");
	});

	it("does not interpret raw HTML, event handlers, embedded resources, or controls", async () => {
		const preview = await render(
			[
				"<script>globalThis.compromised = true</script>",
				"",
				'<img src="https://remote.example/raw.png" onerror="alert(1)">',
				"",
				'<iframe src="https://remote.example"></iframe>',
				"",
				"<form><input autofocus><button>Run</button></form>",
				"",
				'<a href="javascript:alert(1)" onclick="alert(2)">Readable label</a>',
				"",
				"Safe **Markdown** &lt;img src=x onerror=alert(1)&gt;",
			].join("\n"),
		);

		expect(preview.querySelector("script, img, iframe, form, input, button, a, style, svg")).toBeNull();
		expect(preview.querySelector("[src], [href], [onerror], [onclick], [autofocus]")).toBeNull();
		expect(preview.textContent).toContain("Readable label");
		expect(preview.textContent).toContain("Safe Markdown <img src=x onerror=alert(1)>");
		expect(preview.querySelector("strong")?.textContent).toBe("Markdown");
	});

	it.each([499, 500, 501, 1000])("bounds %s plain source characters to 500", async (length) => {
		const preview = await render("x".repeat(length));
		expect(preview.textContent).toBe("x".repeat(Math.min(length, 500)));
	});

	it("cuts source before parsing rather than reading definitions beyond the boundary", async () => {
		const prefix = "[Label][target]";
		const preview = await render(`${prefix}${" ".repeat(500 - prefix.length)}\n\n[target]: https://remote.example`);

		expect(preview.textContent?.trim()).toBe(prefix);
		expect(preview.querySelector("span")).toBeNull();
	});

	it.each([
		["emphasis", `**${"x".repeat(498)}** hidden`],
		["link", `[Label](https://remote.example/${"x".repeat(500)}) hidden`],
	])("handles the 500-character cut inside %s as parser-supported partial syntax", async (_syntax, source) => {
		const preview = await render(source);

		expect(preview.textContent).toBe(source.slice(0, 500));
		expect(preview.textContent).not.toContain("hidden");
		expect(preview.querySelector("strong, a")).toBeNull();
	});

	it("handles a source cutoff inside an unclosed code fence", async () => {
		const preview = await render(`\`\`\`ts\n${"x".repeat(500)}\n\`\`\`\nhidden`);

		expect(preview.querySelector("pre code")?.textContent).toBe(`${"x".repeat(494)}\n`);
		expect(preview.textContent).not.toContain("hidden");
	});

	it("handles an empty preview without adding placeholder or document controls", async () => {
		const preview = await render("");
		expect(preview.textContent).toBe("");
		expect(preview.children.length).toBe(0);
	});

	it("does not intercept card click or double-click events", async () => {
		const onClick = vi.fn();
		const onDoubleClick = vi.fn();
		await act(async () =>
			root.render(
				<div onClick={onClick} onDoubleClick={onDoubleClick}>
					<BoardResponsePreview text="[Label](https://remote.example)" />
				</div>,
			),
		);

		const label = container.querySelector("[data-board-response-preview] span")!;
		await act(async () => {
			label.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			label.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		});
		expect(onClick).toHaveBeenCalledOnce();
		expect(onDoubleClick).toHaveBeenCalledOnce();
	});
});
