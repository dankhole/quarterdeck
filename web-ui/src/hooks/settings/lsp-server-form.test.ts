import { CONFIG_DEFAULTS } from "@runtime-config-defaults";
import { describe, expect, it } from "vitest";
import { createLspServerFormValues, parseLspServerForm } from "./lsp-server-form";

describe("language server settings", () => {
	const template = CONFIG_DEFAULTS.lspServers[0]!;
	it("keeps executable and literal arguments separate", () => {
		const form = createLspServerFormValues(template);
		const result = parseLspServerForm({
			...form,
			command: "/tools/a language server",
			args: '["--stdio","$(echo literal)"]',
		});
		expect(result.error).toBeNull();
		expect(result.server?.command).toBe("/tools/a language server");
		expect(result.server?.args).toEqual(["--stdio", "$(echo literal)"]);
	});
	it("rejects malformed options and shell-string arguments", () => {
		const form = createLspServerFormValues(template);
		expect(parseLspServerForm({ ...form, args: "--stdio" }).error).toContain("JSON array");
		expect(parseLspServerForm({ ...form, initializationOptions: "{" }).error).toContain("valid JSON");
		expect(parseLspServerForm({ ...form, extensions: "ts" }).server).toBeNull();
	});
	it("round trips optional initialization and environment fields", () => {
		const server = {
			...template,
			rootMarkers: ["language config.json"],
			initializationOptions: { cache: false },
			env: { LANG: "en_US.UTF-8" },
		};
		expect(parseLspServerForm(createLspServerFormValues(server)).server).toEqual(server);
	});
});
