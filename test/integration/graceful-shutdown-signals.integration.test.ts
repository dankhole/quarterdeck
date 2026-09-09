import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveTsxLoaderImportSpecifier } from "../utilities/integration-server";
import { createTempDir } from "../utilities/temp-dir";

describe.skipIf(process.platform === "win32")("direct-launch shutdown signal delivery", () => {
	it("finishes persistence after an OS-delivered duplicate SIGINT without npm launch metadata", async () => {
		const sandbox = createTempDir("quarterdeck-shutdown-signals-");
		const markerPath = join(sandbox.path, "cleanup-complete");
		const moduleUrl = pathToFileURL(resolve("src/core/graceful-shutdown.ts")).href;
		const env = { ...process.env };
		delete env.npm_execpath;
		const child = spawn(
			process.execPath,
			[
				"--import",
				resolveTsxLoaderImportSpecifier(),
				"--input-type=module",
				"--eval",
				`
					import { writeFile } from "node:fs/promises";
					import { setTimeout as delay } from "node:timers/promises";
					import { installGracefulShutdownHandlers } from ${JSON.stringify(moduleUrl)};
					installGracefulShutdownHandlers({
						process,
						delayMs: 3000,
						exit: code => process.exit(code),
						onSecondSignal: () => console.error("forced exit"),
						onShutdown: async () => {
							setTimeout(() => process.kill(process.pid, "SIGINT"), 25);
							await delay(150);
							await writeFile(${JSON.stringify(markerPath)}, "complete");
						},
					});
					// Signal listeners alone do not keep Node alive until OS delivery.
					setInterval(() => {}, 1000);
					setTimeout(() => process.kill(process.pid, "SIGINT"), 0);
				`,
			],
			{ env, stdio: ["ignore", "pipe", "pipe"] },
		);
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const exited = once(child, "close");
		const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
		try {
			const [code, signal] = await exited;
			expect({ code, signal, stderr }).toEqual({ code: 130, signal: null, stderr: "" });
			expect(existsSync(markerPath)).toBe(true);
			expect(readFileSync(markerPath, "utf8")).toBe("complete");
		} finally {
			clearTimeout(deadline);
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
				await exited;
			}
			sandbox.cleanup();
		}
	});
});
