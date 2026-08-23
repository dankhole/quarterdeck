import {
	RUNTIME_OPEN_TARGET_IDS_BY_PLATFORM,
	type RuntimeOpenTargetId,
	type RuntimeOpenTargetPlatform,
} from "@runtime-contract";
import cursorIcon from "@/assets/open-targets/cursor.svg";
import finderIcon from "@/assets/open-targets/finder.svg";
import ghosttyIcon from "@/assets/open-targets/ghostty.svg";
import intellijIdeaIcon from "@/assets/open-targets/intellijidea.svg";
import iterm2Icon from "@/assets/open-targets/iterm2.svg";
import riderIcon from "@/assets/open-targets/rider.svg";
import terminalIcon from "@/assets/open-targets/terminal.svg";
import vscodeIcon from "@/assets/open-targets/vscode.svg";
import warpIcon from "@/assets/open-targets/warp.svg";
import windsurfIcon from "@/assets/open-targets/windsurf.svg";
import xcodeIcon from "@/assets/open-targets/xcode.svg";
import zedIcon from "@/assets/open-targets/zed.svg";
import { LocalStorageKey } from "@/storage/local-storage-store";

export const PREFERRED_OPEN_TARGET_STORAGE_KEY = LocalStorageKey.PreferredOpenTarget;

export type OpenTargetPlatform = RuntimeOpenTargetPlatform;
export type OpenTargetId = RuntimeOpenTargetId;

export interface OpenTargetOption {
	id: OpenTargetId;
	label: string;
	iconSrc: string;
}

const DEFAULT_OPEN_TARGET: OpenTargetOption = {
	id: "vscode",
	label: "VS Code",
	iconSrc: vscodeIcon,
};

const OPEN_TARGET_OPTIONS: readonly OpenTargetOption[] = [
	DEFAULT_OPEN_TARGET,
	{
		id: "vscode-insiders",
		label: "VS Code Insiders",
		iconSrc: vscodeIcon,
	},
	{
		id: "cursor",
		label: "Cursor",
		iconSrc: cursorIcon,
	},
	{
		id: "windsurf",
		label: "Windsurf",
		iconSrc: windsurfIcon,
	},
	{
		id: "finder",
		label: "Finder",
		iconSrc: finderIcon,
	},
	{
		id: "terminal",
		label: "Terminal",
		iconSrc: terminalIcon,
	},
	{
		id: "iterm2",
		label: "Iterm2",
		iconSrc: iterm2Icon,
	},
	{
		id: "ghostty",
		label: "Ghostty",
		iconSrc: ghosttyIcon,
	},
	{
		id: "warp",
		label: "Warp",
		iconSrc: warpIcon,
	},
	{
		id: "xcode",
		label: "Xcode",
		iconSrc: xcodeIcon,
	},
	{
		id: "intellijidea",
		label: "Intellij Idea",
		iconSrc: intellijIdeaIcon,
	},
	{
		id: "rider",
		label: "Rider",
		iconSrc: riderIcon,
	},
	{
		id: "zed",
		label: "Zed",
		iconSrc: zedIcon,
	},
];

const openTargetById = new Map<OpenTargetId, OpenTargetOption>(
	OPEN_TARGET_OPTIONS.map((option) => [option.id, option]),
);

export function resolveOpenTargetPlatform(): OpenTargetPlatform {
	if (typeof navigator === "undefined") {
		return "other";
	}
	const source = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
	if (source.includes("mac") || source.includes("darwin")) {
		return "mac";
	}
	if (source.includes("win")) {
		return "windows";
	}
	if (source.includes("linux") || source.includes("x11")) {
		return "linux";
	}
	return "other";
}

function getDefaultOpenTargetId(platform: OpenTargetPlatform): OpenTargetId {
	const firstId = RUNTIME_OPEN_TARGET_IDS_BY_PLATFORM[platform][0];
	return firstId ?? DEFAULT_OPEN_TARGET.id;
}

function getOpenTargetLabel(targetId: OpenTargetId, platform: OpenTargetPlatform): string {
	if (targetId === "finder") {
		if (platform === "windows") {
			return "File Explorer";
		}
		if (platform === "linux" || platform === "other") {
			return "File Manager";
		}
	}
	const option = openTargetById.get(targetId);
	return option?.label ?? DEFAULT_OPEN_TARGET.label;
}

function isOpenTargetSupported(targetId: OpenTargetId, platform: OpenTargetPlatform): boolean {
	const supportedTargets: readonly OpenTargetId[] = RUNTIME_OPEN_TARGET_IDS_BY_PLATFORM[platform];
	return supportedTargets.includes(targetId);
}

function isOpenTargetId(value: string | null): value is OpenTargetId {
	if (!value) {
		return false;
	}
	return openTargetById.has(value as OpenTargetId);
}

export function normalizeOpenTargetId(value: string | null): OpenTargetId | null {
	if (!value) {
		return null;
	}
	if (value === "ghostie") {
		return "ghostty";
	}
	if (value === "intellij_idea") {
		return "intellijidea";
	}
	if (value === "jetbrains_rider") {
		return "rider";
	}
	if (isOpenTargetId(value)) {
		return value;
	}
	return null;
}

export function getOpenTargetOptions(platform: OpenTargetPlatform): readonly OpenTargetOption[] {
	return RUNTIME_OPEN_TARGET_IDS_BY_PLATFORM[platform].map((targetId) => {
		const option = openTargetById.get(targetId) ?? DEFAULT_OPEN_TARGET;
		return {
			...option,
			label: getOpenTargetLabel(targetId, platform),
		};
	});
}

export function getOpenTargetOption(targetId: OpenTargetId, platform: OpenTargetPlatform): OpenTargetOption {
	const fallbackId = getDefaultOpenTargetId(platform);
	const resolvedTargetId = isOpenTargetSupported(targetId, platform) ? targetId : fallbackId;
	const option = openTargetById.get(resolvedTargetId) ?? DEFAULT_OPEN_TARGET;
	return {
		...option,
		label: getOpenTargetLabel(resolvedTargetId, platform),
	};
}
