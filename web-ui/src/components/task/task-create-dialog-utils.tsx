import { ArrowBigUp, Command, CornerDownLeft, Option } from "lucide-react";
import type { CSSProperties, ReactElement } from "react";
import { isMacPlatform } from "@/utils/platform";

export const DIALOG_STYLE: CSSProperties = {
	width: "960px",
	height: "800px",
	minWidth: "min(400px, calc(100vw - 32px))",
	minHeight: "min(480px, 90dvh)",
	maxWidth: "calc(100vw - 32px)",
	maxHeight: "90dvh",
};

export type TaskCreateStartAction = "start" | "start_and_open";

export const DEFAULT_PRIMARY_START_ACTION: TaskCreateStartAction = "start";

export function normalizeStoredTaskCreateStartAction(value: string): TaskCreateStartAction | null {
	if (value === "start" || value === "start_and_open") {
		return value;
	}
	return null;
}

export function parseListItems(text: string): string[] {
	const lines = text.split("\n");
	const nonEmptyLines = lines.filter((line) => line.trim().length > 0);

	if (nonEmptyLines.length < 2) {
		return [];
	}

	const numberedRegex = /^\s*\d+[.)]\s+(.+)$/;
	const numberedItems = nonEmptyLines.map((line) => numberedRegex.exec(line));
	if (numberedItems.every((match) => match !== null)) {
		return numberedItems.map((match) => match[1]!.trim());
	}

	const bulletRegex = /^\s*[-*+•]\s+(.+)$/;
	const bulletItems = nonEmptyLines.map((line) => bulletRegex.exec(line));
	if (bulletItems.every((match) => match !== null)) {
		return bulletItems.map((match) => match[1]!.trim());
	}

	return [];
}

export function ButtonShortcut({
	includeShift = false,
	includeAlt = false,
}: {
	includeShift?: boolean;
	includeAlt?: boolean;
}): ReactElement {
	return (
		<span className="inline-flex items-center gap-0.5 ml-1.5" aria-hidden>
			<Command size={12} />
			{includeAlt ? (
				isMacPlatform ? (
					<Option size={12} />
				) : (
					<span className="text-[10px] font-medium leading-none">Alt</span>
				)
			) : null}
			{includeShift ? <ArrowBigUp size={12} /> : null}
			<CornerDownLeft size={12} />
		</span>
	);
}
