import { describe, expect, it } from "vitest";

import {
	buildQuarterdeckCommandLine,
	buildQuarterdeckCommandParts,
	buildShellCommandLine,
	resolveQuarterdeckCommandParts,
} from "../../src/core";

describe("resolveQuarterdeckCommandParts", () => {
	it("resolves node plus script entrypoint", () => {
		const parts = resolveQuarterdeckCommandParts({
			execPath: "/usr/local/bin/node",
			argv: ["/usr/local/bin/node", "/tmp/.npx/123/node_modules/quarterdeck/dist/cli.js", "--port", "9123"],
		});
		expect(parts).toEqual(["/usr/local/bin/node", "/tmp/.npx/123/node_modules/quarterdeck/dist/cli.js"]);
	});

	it("resolves tsx launched cli entrypoint", () => {
		const parts = resolveQuarterdeckCommandParts({
			execPath: "/usr/local/bin/node",
			argv: ["/usr/local/bin/node", "/repo/node_modules/tsx/dist/cli.mjs", "/repo/src/cli.ts", "--no-open"],
		});
		expect(parts).toEqual(["/usr/local/bin/node", "/repo/node_modules/tsx/dist/cli.mjs", "/repo/src/cli.ts"]);
	});

	it("preserves node execArgv for source entrypoints", () => {
		const parts = resolveQuarterdeckCommandParts({
			execPath: "/usr/local/bin/node",
			execArgv: ["--import", "tsx"],
			argv: ["/usr/local/bin/node", "/repo/src/cli.ts", "--no-open"],
		});
		expect(parts).toEqual(["/usr/local/bin/node", "--import", "tsx", "/repo/src/cli.ts"]);
	});

	it("falls back to execPath when no entrypoint path is available", () => {
		const parts = resolveQuarterdeckCommandParts({
			execPath: "/usr/local/bin/quarterdeck",
			argv: ["/usr/local/bin/quarterdeck", "hooks", "ingest"],
		});
		expect(parts).toEqual(["/usr/local/bin/quarterdeck"]);
	});
});

describe("buildQuarterdeckCommandParts", () => {
	it("appends command arguments to resolved runtime invocation", () => {
		expect(
			buildQuarterdeckCommandParts(["hooks", "ingest"], {
				execPath: "/usr/local/bin/node",
				argv: ["/usr/local/bin/node", "/tmp/.npx/321/node_modules/quarterdeck/dist/cli.js"],
			}),
		).toEqual(["/usr/local/bin/node", "/tmp/.npx/321/node_modules/quarterdeck/dist/cli.js", "hooks", "ingest"]);
	});

	it("serializes the resolved invocation through the platform command-line owner", () => {
		const context = {
			execPath: "C:\\Quarterdeck %NAME% ! ^ & (runtime)\\node.exe",
			argv: ["C:\\Quarterdeck %NAME% ! ^ & (runtime)\\node.exe", "C:\\Quarterdeck source\\cli.js"],
		};
		const parts = buildQuarterdeckCommandParts(["hooks", "ingest", "--event", "activity"], context);
		const env = { SystemRoot: "C:\\Windows" };

		expect(buildQuarterdeckCommandLine(["hooks", "ingest", "--event", "activity"], context, "win32", env)).toBe(
			buildShellCommandLine(parts[0] ?? "", parts.slice(1), "win32", env),
		);
	});
});
