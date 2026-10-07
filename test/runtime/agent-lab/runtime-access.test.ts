import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planAuthenticatedLabNavigation } from "../../../scripts/agent-lab/browser-runtime-access";
import { createRuntimeLogSanitizer } from "../../../scripts/agent-lab/runtime-log-sanitizer";
import { copyAgentLabJsonState } from "../../../scripts/agent-lab/snapshot";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Agent Lab runtime admission privacy", () => {
	it("opens a blank session before private admission while retaining stable public navigation", () => {
		const args = ["--config", "/synthetic/config.json", "-s=qd-test", "open", "http://127.0.0.1:5555/project?a=1"];
		const planned = planAuthenticatedLabNavigation(args, { webUrl: "http://127.0.0.1:5555" });
		expect(planned?.prepareArguments?.at(-1)).toBe("about:blank");
		expect(planned?.navigationArguments).toEqual(["-s=qd-test", "goto", args.at(-1)]);
		expect(args.at(-1)).toBe("http://127.0.0.1:5555/project?a=1");
		expect(
			planAuthenticatedLabNavigation(["-s=qd-test", "open", "https://external.test"], {
				webUrl: "http://127.0.0.1:5555",
			}),
		).toBeNull();
	});

	it("reauthenticates reload without replacing the current project navigation", () => {
		const args = ["--session", "qd-test", "reload"];
		expect(planAuthenticatedLabNavigation(args, { webUrl: "http://127.0.0.1:5555" })).toEqual({
			prepareArguments: null,
			navigationArguments: args,
			sessionArguments: ["--session", "qd-test"],
		});
	});

	it("redacts a capability split across stdout chunks while preserving stable runtime URLs", async () => {
		const sanitizer = createRuntimeLogSanitizer();
		const chunks: Buffer[] = [];
		sanitizer.on("data", (chunk: Buffer) => chunks.push(chunk));
		const ended = once(sanitizer, "end");
		sanitizer.write("Quarterdeck running at http://127.0.0.1:5555\nBrowser URL: http://127.0.0.1:5555/api/runtime/");
		sanitizer.end("client-bootstrap?capability=private-capability\nRuntime ready\n");
		await ended;
		const output = Buffer.concat(chunks).toString("utf8");
		expect(output).toContain("Quarterdeck running at http://127.0.0.1:5555");
		expect(output).toContain("Browser URL: [private browser bootstrap]");
		expect(output).not.toContain("private-capability");
	});

	it("excludes independent diagnostic and management credentials from copied lab state", async () => {
		const root = await mkdtemp(join(tmpdir(), "qd-lab-state-privacy-"));
		directories.push(root);
		const source = join(root, "source");
		const destination = join(root, "evidence");
		for (const directory of ["diagnostics", "runtime-ownership", "projects"]) {
			await mkdir(join(source, directory), { recursive: true });
			await writeFile(join(source, directory, "state.json"), JSON.stringify({ directory }));
		}
		await copyAgentLabJsonState(source, destination);
		expect(await readdir(destination)).toEqual(["projects"]);
		expect(await readFile(join(destination, "projects", "state.json"), "utf8")).toContain("projects");
	});
});
