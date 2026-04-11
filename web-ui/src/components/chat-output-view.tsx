import type { ReactElement } from "react";
import { useEffect, useRef } from "react";

import { TERMINAL_FONT_SIZE, TERMINAL_PRIMARY_FONT } from "@/terminal/terminal-options";
import { TERMINAL_THEME_COLORS } from "@/terminal/theme-colors";

const FONT_FAMILY = `'${TERMINAL_PRIMARY_FONT}', 'JetBrainsMono Nerd Font', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'SF Mono', Menlo, Monaco, 'Courier New', monospace`;

interface ChatOutputViewProps {
	lines: string[];
	backgroundColor: string;
}

export function ChatOutputView({ lines, backgroundColor }: ChatOutputViewProps): ReactElement {
	const scrollRef = useRef<HTMLDivElement>(null);
	const isAutoScrollRef = useRef(true);

	useEffect(() => {
		const el = scrollRef.current;
		if (!el) {
			return;
		}
		const handler = () => {
			// Auto-scroll if user is near the bottom (within 40px)
			const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
			isAutoScrollRef.current = distanceFromBottom < 40;
		};
		el.addEventListener("scroll", handler, { passive: true });
		return () => {
			el.removeEventListener("scroll", handler);
		};
	}, []);

	useEffect(() => {
		if (isAutoScrollRef.current && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [lines]);

	return (
		<div
			ref={scrollRef}
			style={{
				flex: "1 1 0",
				minHeight: 0,
				overflow: "auto",
				padding: "4px 8px",
				background: backgroundColor,
				color: TERMINAL_THEME_COLORS.textPrimary,
				fontFamily: FONT_FAMILY,
				fontSize: TERMINAL_FONT_SIZE,
				lineHeight: 1.4,
				whiteSpace: "pre-wrap",
				wordBreak: "break-word",
				WebkitFontSmoothing: "antialiased",
				MozOsxFontSmoothing: "grayscale",
			}}
		>
			{lines.length === 0 ? null : lines.join("\n")}
		</div>
	);
}
