import { Component, type ReactNode, type RefObject } from "react";
import { type DiffScrollLine, DiffScrollTargetContext } from "@/components/shared/diff-scroll-target";
import { relocateDiffLine } from "@/hooks/git/diff-line-anchor";
import type { FileDiffGroup } from "./diff-viewer-utils";

type Position =
	| { kind: "line"; line: DiffScrollLine; source: string; top: number }
	| { kind: "header" | "footer"; top: number };

interface ScrollAnchor {
	path: string;
	position: Position;
	sectionTop: number;
	neighbors: { path: string; top: number }[];
}

interface Props {
	children: ReactNode;
	containerRef: RefObject<HTMLDivElement | null>;
	groups: FileDiffGroup[];
	scopeKey: string;
	selectedPath: string | null;
}

function sections(container: HTMLElement): HTMLElement[] {
	return Array.from(container.querySelectorAll<HTMLElement>("[data-diff-path]"));
}

function sourceFor(groups: FileDiffGroup[], line: DiffScrollLine): string {
	const entry = groups.find((group) => group.path === line.path)?.entries[0];
	return (line.side === "removed" ? entry?.oldText : entry?.newText) ?? "";
}

function readLine(row: HTMLElement, path: string): DiffScrollLine {
	return {
		path,
		side: row.dataset.diffSide === "removed" ? "removed" : "current",
		lineNumber: Number(row.dataset.diffLine),
	};
}

/**
 * React's snapshot phase is essential here: effect cleanup runs after child DOM
 * mutations. Capture code identity before commit, then restore its viewport
 * offset before paint. This owns presentation only, never review/session state.
 */
export class DiffScrollPreserver extends Component<Props> {
	private target: { current: DiffScrollLine | null } = { current: null };
	private anchor: ScrollAnchor | null = null;
	private pending: ScrollAnchor | null = null;
	private mutations: MutationObserver | null = null;
	private resize: ResizeObserver | null = null;

	componentDidMount(): void {
		const container = this.props.containerRef.current;
		if (!container) return;
		container.addEventListener("scroll", this.onScroll, { passive: true });
		this.mutations = new MutationObserver(this.onLayout);
		this.mutations.observe(container, { childList: true, subtree: true });
		if (typeof ResizeObserver !== "undefined") {
			this.resize = new ResizeObserver(this.onLayout);
		}
		this.observeSections();
		this.anchor = this.capture(this.props.groups);
	}

	getSnapshotBeforeUpdate(previous: Props): ScrollAnchor | null {
		this.pending = null;
		this.target.current = null;
		// Explicit navigation and comparison/repository changes take precedence.
		if (previous.scopeKey !== this.props.scopeKey || previous.selectedPath !== this.props.selectedPath) {
			this.anchor = null;
			return null;
		}
		if (previous.groups === this.props.groups) return null;
		const anchor = this.capture(previous.groups);
		if (anchor?.position.kind === "line") {
			const { line, source } = anchor.position;
			const nextSource = sourceFor(this.props.groups, line);
			const nextLine = relocateDiffLine(source, nextSource, line.lineNumber);
			if (nextLine !== null) {
				let nextLocation = { ...line, lineNumber: nextLine };
				if (line.side === "removed") {
					// A previously deleted base line can reappear as current context.
					// Resolve that identity before falling back to other deleted rows.
					const currentSource = sourceFor(this.props.groups, { ...line, side: "current" });
					const currentLine = relocateDiffLine(nextSource, currentSource, nextLine, "none");
					if (currentLine !== null) nextLocation = { ...line, side: "current", lineNumber: currentLine };
				}
				anchor.position = {
					...anchor.position,
					source: sourceFor(this.props.groups, nextLocation),
					line: nextLocation,
				};
				this.target.current = anchor.position.line;
			} else {
				anchor.position = { kind: "header", top: anchor.sectionTop };
			}
		}
		this.pending = anchor;
		return anchor;
	}

	componentDidUpdate(previous: Props, _state: unknown, snapshot: ScrollAnchor | null): void {
		if (snapshot) this.restore(snapshot);
		this.observeSections();
		// Navigation runs in the parent's passive effect. Do not seed a layout
		// anchor from its old viewport and replay it over that newer intent.
		if (
			!this.pending &&
			previous.scopeKey === this.props.scopeKey &&
			previous.selectedPath === this.props.selectedPath
		) {
			this.anchor = this.capture(this.props.groups);
		}
	}

	componentWillUnmount(): void {
		this.props.containerRef.current?.removeEventListener("scroll", this.onScroll);
		this.mutations?.disconnect();
		this.resize?.disconnect();
	}

	private observeSections(): void {
		this.resize?.disconnect();
		const container = this.props.containerRef.current;
		if (container) for (const section of sections(container)) this.resize?.observe(section);
	}

	private onScroll = (): void => {
		// Never replay a pending refresh over a newer user scroll/navigation.
		this.pending = null;
		this.target.current = null;
		this.anchor = this.capture(this.props.groups);
	};

	private onLayout = (): void => {
		const anchor = this.pending ?? this.anchor;
		if (anchor) this.restore(anchor);
		if (!this.pending) this.anchor = this.capture(this.props.groups);
	};

	private capture(groups: FileDiffGroup[]): ScrollAnchor | null {
		const container = this.props.containerRef.current;
		if (!container || container.clientHeight === 0) return null;
		const top = container.getBoundingClientRect().top + container.clientTop;
		const allSections = sections(container);
		const section = allSections.find((element) => element.getBoundingClientRect().bottom > top);
		if (!section || section.getBoundingClientRect().top >= top + container.clientHeight) return null;
		const path = section.dataset.diffPath!;
		const rect = section.getBoundingClientRect();
		const sectionTop = rect.top - top;
		const header = section.querySelector<HTMLElement>(".kb-diff-file-header");
		let position: Position = { kind: "header", top: sectionTop };
		// File headers are sticky. Use their natural position inside the section,
		// not their pinned viewport rect, to distinguish header from code.
		if (header && rect.top + header.getBoundingClientRect().height <= top) {
			const rows = Array.from(section.querySelectorAll<HTMLElement>("[data-diff-line]"));
			// Prefer current content when both split sides occupy the same row.
			const visible = rows.filter((row) => row.getBoundingClientRect().bottom > top);
			const row =
				visible.find(
					(candidate) =>
						candidate.dataset.diffSide === "current" &&
						candidate.getBoundingClientRect().top === visible[0]?.getBoundingClientRect().top,
				) ?? visible[0];
			if (row) {
				const line = readLine(row, path);
				position = {
					kind: "line",
					line,
					source: sourceFor(groups, line),
					top: row.getBoundingClientRect().top - top,
				};
			} else {
				position = { kind: "footer", top: rect.bottom - top };
			}
		}
		const index = allSections.indexOf(section);
		const neighbors = [allSections[index + 1], allSections[index - 1]]
			.filter((element): element is HTMLElement => element !== undefined)
			.map((element) => ({ path: element.dataset.diffPath!, top: element.getBoundingClientRect().top - top }));
		return { path, position, sectionTop, neighbors };
	}

	private restore(anchor: ScrollAnchor): void {
		const container = this.props.containerRef.current;
		if (!container) return;
		const allSections = sections(container);
		const section = allSections.find((element) => element.dataset.diffPath === anchor.path);
		const viewportTop = container.getBoundingClientRect().top + container.clientTop;
		let nextTop: number | undefined;
		let previousTop = anchor.position.top;
		if (!section) {
			for (const neighbor of anchor.neighbors) {
				const element = allSections.find((candidate) => candidate.dataset.diffPath === neighbor.path);
				if (!element) continue;
				nextTop = element.getBoundingClientRect().top - viewportTop;
				previousTop = neighbor.top;
				break;
			}
		} else if (anchor.position.kind === "line") {
			const { line } = anchor.position;
			const rows = Array.from(section.querySelectorAll<HTMLElement>("[data-diff-line]")).filter(
				(row) => row.dataset.diffSide === line.side,
			);
			let row = rows.find((candidate) => Number(candidate.dataset.diffLine) === line.lineNumber);
			if (!row && section.querySelector('[data-diff-scroll-pending="true"]')) return;
			// If the code became collapsed context, retain the nearest visible line.
			row ??= rows.sort(
				(a, b) =>
					Math.abs(Number(a.dataset.diffLine) - line.lineNumber) -
					Math.abs(Number(b.dataset.diffLine) - line.lineNumber),
			)[0];
			if (row) nextTop = row.getBoundingClientRect().top - viewportTop;
			else {
				nextTop = section.getBoundingClientRect().top - viewportTop;
				previousTop = anchor.sectionTop;
			}
		} else {
			const rect = section.getBoundingClientRect();
			nextTop = (anchor.position.kind === "footer" ? rect.bottom : rect.top) - viewportTop;
		}
		if (nextTop !== undefined && Math.abs(nextTop - previousTop) > 0.5) {
			container.scrollTop += nextTop - previousTop;
		}
		this.pending = null;
		this.target.current = null;
	}

	render(): ReactNode {
		return (
			<DiffScrollTargetContext.Provider value={this.target}>{this.props.children}</DiffScrollTargetContext.Provider>
		);
	}
}
