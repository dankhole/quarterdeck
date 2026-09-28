import { describe, expect, it } from "vitest";
import {
	buildSparseGlobalConfigPayload,
	getGlobalConfigDefaults,
	hasGlobalConfigFieldChanges,
	normalizeGlobalConfigFields,
} from "../../../src/config/global-config-fields";
import { DEFAULT_LSP_SERVERS } from "../../../src/config/lsp-defaults";
import { lspServersSchema } from "../../../src/core/api/code-navigation";

describe("language server configuration", () => {
	it("is opt-in and preserves structured arguments including shell metacharacters as literal text", () => {
		const defaults = getGlobalConfigDefaults();
		expect(defaults.codeNavigationEnabled).toBe(false);
		expect(defaults.lspServers).toEqual(DEFAULT_LSP_SERVERS);
		const servers = [{ ...DEFAULT_LSP_SERVERS[0], args: ["--stdio", "literal; $(text)"] }];
		expect(lspServersSchema.parse(servers)[0]?.args).toEqual(["--stdio", "literal; $(text)"]);
		expect(
			buildSparseGlobalConfigPayload({ ...defaults, lspServers: structuredClone(defaults.lspServers) }, null),
		).not.toHaveProperty("lspServers");
		expect(
			hasGlobalConfigFieldChanges(defaults, { ...defaults, lspServers: structuredClone(defaults.lspServers) }),
		).toBe(false);
	});
	it("rejects duplicate IDs, traversal root markers and NUL arguments, and normalizes invalid saved config safely", () => {
		const server = DEFAULT_LSP_SERVERS[0];
		expect(lspServersSchema.safeParse([server, server]).success).toBe(false);
		expect(lspServersSchema.safeParse([{ ...server, rootMarkers: ["../outside"] }]).success).toBe(false);
		expect(lspServersSchema.safeParse([{ ...server, args: ["bad\0arg"] }]).success).toBe(false);
		expect(normalizeGlobalConfigFields({ lspServers: "bad" }).lspServers).toEqual(DEFAULT_LSP_SERVERS);
	});
});
