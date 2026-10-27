// @vitest-environment node

import { CONFIG_DEFAULTS } from "@runtime-config-defaults";
import { describe, expect, it } from "vitest";
import {
	type CodeNavigationSource,
	codeNavigationUnavailableReason,
	groupCodeNavigationLocations,
} from "./code-navigation";

describe("code navigation eligibility", () => {
	const source: CodeNavigationSource = {
		path: "src/example.ts",
		content: "const answer = 42;",
		eligibility: "eligible",
	};
	const input = {
		projectId: "project",
		scope: { taskId: null },
		config: { codeNavigationEnabled: true, lspServers: CONFIG_DEFAULTS.lspServers },
		source,
	};
	it("accepts an enabled matching template in a live worktree", () => {
		expect(codeNavigationUnavailableReason(input)).toBeNull();
	});
	it("explains disabled, unmatched, incomplete, and ref scopes", () => {
		expect(
			codeNavigationUnavailableReason({ ...input, config: { ...input.config, codeNavigationEnabled: false } }),
		).toContain("Enable Code Navigation");
		expect(codeNavigationUnavailableReason({ ...input, source: { ...source, path: "file.unknown" } })).toContain(
			"No enabled language server",
		);
		expect(codeNavigationUnavailableReason({ ...input, source: { ...source, eligibility: "incomplete" } })).toContain(
			"complete text file",
		);
		expect(codeNavigationUnavailableReason({ ...input, scope: { taskId: null, ref: "main" } })).toContain(
			"live workspaces",
		);
		expect(codeNavigationUnavailableReason({ ...input, source: { ...source, eligibility: "read-only" } })).toContain(
			"live workspaces",
		);
		expect(codeNavigationUnavailableReason({ ...input, source: null })).toContain("complete text file");
	});
	it("groups locations without discarding exact result ranges", () => {
		const range = { start: { line: 2, character: 3 }, end: { line: 2, character: 9 } };
		const locations = [
			{ path: "a.ts", range },
			{ path: "b.ts", range },
			{ path: "a.ts", range },
		];
		expect(Array.from(groupCodeNavigationLocations(locations).keys())).toEqual(["a.ts", "b.ts"]);
		expect(groupCodeNavigationLocations(locations).get("a.ts")).toEqual([locations[0], locations[2]]);
	});
});
