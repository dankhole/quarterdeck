import type { RuntimeOpenTargetId } from "./host-integrations.js";

const applicationNames: Partial<Record<RuntimeOpenTargetId, readonly string[]>> = {
	vscode: ["Visual Studio Code"],
	"vscode-insiders": ["Visual Studio Code - Insiders"],
	cursor: ["Cursor"],
	windsurf: ["Windsurf"],
	terminal: ["Terminal"],
	iterm2: ["iTerm", "iTerm2"],
	ghostty: ["Ghostty", "Ghostie"],
	warp: ["Warp"],
	xcode: ["Xcode"],
	intellijidea: ["IntelliJ IDEA", "IntelliJ IDEA CE"],
	rider: ["Rider", "JetBrains Rider"],
	zed: ["Zed"],
};

/** Canonical allowlisted LaunchServices arguments, shared by CLI and native shell. */
export function resolveMacOpenProjectArguments(targetId: RuntimeOpenTargetId, projectPath: string): string[][] {
	if (targetId === "finder") return [[projectPath]];
	return (applicationNames[targetId] ?? applicationNames.vscode ?? []).map((name) => ["-a", name, projectPath]);
}
