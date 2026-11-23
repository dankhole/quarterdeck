import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { callCodex } from "../../../src/title/codex-client";
import { createTempDir } from "../../utilities/temp-dir";

it.skipIf(process.platform !== "win32")(
	"preserves Codex helper arguments and UTF-8 stdin for an npm install",
	async () => {
		const temp = createTempDir("quarterdeck-codex-npm-launch-");
		try {
			const shimDir = join(temp.path, "npm prefix");
			const entryDir = join(shimDir, "node_modules", "@openai", "codex", "bin");
			mkdirSync(entryDir, { recursive: true });
			writeFileSync(join(shimDir, "codex.cmd"), '@node "%~dp0node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
			writeFileSync(
				join(shimDir, "codex.ps1"),
				'$input | & node "$PSScriptRoot/node_modules/@openai/codex/bin/codex.js" $args\nexit $LASTEXITCODE\n',
			);
			writeFileSync(
				join(entryDir, "codex.js"),
				`const assert = require("node:assert/strict");
const args = process.argv.slice(2);
assert.equal(args[0], "exec");
assert.deepEqual(args.slice(-2), ["--", "-"]);
assert.ok(args.includes('model_reasoning_effort="low"'));
const config = args.find((arg) => arg.startsWith("developer_instructions="));
assert.ok(JSON.parse(config.split("=").slice(1).join("=")).startsWith('Return only a "short title".\\nNo commentary.'));
process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", (data) => input += data);
process.stdin.on("end", () => {
  assert.ok(input.includes("<input-context>\\nRepair Montréal search 東京\\n</input-context>"));
  console.log("Search Repair");
});
`,
			);
			vi.stubEnv("PATH", [shimDir, dirname(process.execPath)].join(delimiter));
			vi.stubEnv("PATHEXT", ".COM;.EXE;.BAT;.CMD;.PS1");

			await expect(
				callCodex({
					systemPrompt: 'Return only a "short title".\nNo commentary.',
					userPrompt: "Repair Montréal search 東京",
					timeoutMs: 5_000,
					model: "fixture-model",
				}),
			).resolves.toBe("Search Repair");
		} finally {
			vi.unstubAllEnvs();
			temp.cleanup();
		}
	},
);
