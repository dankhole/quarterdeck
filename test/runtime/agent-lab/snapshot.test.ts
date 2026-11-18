import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { copyAgentLabJsonState } from "../../../scripts/agent-lab/snapshot";

describe("packaged Agent Lab state snapshots", () => {
	it("preserves synthetic board state but excludes private admission, hooks and diagnostic credentials", async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-snapshot-test-"));
		try {
			const source = join(root, "source");
			const destination = join(root, "snapshot");
			for (const directory of ["project", "diagnostics", "runtime-ownership", "hooks"])
				await mkdir(join(source, directory), { recursive: true });
			await writeFile(join(source, "project", "board.json"), '{"synthetic":true}');
			await writeFile(join(source, "project", "not-json.txt"), "not evidence");
			for (const directory of ["diagnostics", "runtime-ownership", "hooks"])
				await writeFile(join(source, directory, "private.json"), '{"credential":"never-copy"}');
			await copyAgentLabJsonState(source, destination);
			expect(await readdir(destination)).toEqual(["project"]);
			expect(await readdir(join(destination, "project"))).toEqual(["board.json"]);
			expect(await readFile(join(destination, "project", "board.json"), "utf8")).toBe('{"synthetic":true}');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
