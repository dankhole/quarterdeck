import { describe, expect, it } from "vitest";

import { resolveNpmCommand } from "../../scripts/npm-command.mjs";

describe("resolveNpmCommand", () => {
	it("launches the npm JavaScript entrypoint through Node on Windows", () => {
		expect(
			resolveNpmCommand(["run", "build"], {
				platform: "win32",
				nodeBinary: "C:\\Node\\node.exe",
				env: { NPM_EXECPATH: "C:\\Node\\node_modules\\npm\\bin\\npm-cli.js" },
			}),
		).toEqual({
			command: "C:\\Node\\node.exe",
			args: ["C:\\Node\\node_modules\\npm\\bin\\npm-cli.js", "run", "build"],
		});
	});

	it("uses the normal npm executable outside Windows", () => {
		expect(resolveNpmCommand(["test"], { platform: "linux" })).toEqual({
			command: "npm",
			args: ["test"],
		});
	});

	it("rejects relative Windows npm and Node entrypoints", () => {
		expect(() =>
			resolveNpmCommand(["test"], {
				platform: "win32",
				nodeBinary: "node.exe",
				env: { npm_execpath: "scripts/npm-cli.js" },
			}),
		).toThrow("npm_execpath");
		expect(() =>
			resolveNpmCommand(["test"], {
				platform: "win32",
				nodeBinary: "node.exe",
				env: { npm_execpath: "C:\\Node\\npm-cli.js" },
			}),
		).toThrow("absolute Node.js executable path");
	});
});
