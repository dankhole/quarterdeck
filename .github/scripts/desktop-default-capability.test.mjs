import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const workflow = (await readFile(new URL("../workflows/publish.yml", import.meta.url), "utf8")).replace(/\r\n/gu, "\n");
const guardStep = workflow.match(
	/      - name: Validate desktop-default capability from the immutable tag\n([\s\S]*?)(?=      - name:)/u,
)?.[1];
assert.ok(guardStep, "publish.yml must retain the desktop-default capability guard");
const guardBody = guardStep.match(/          node --input-type=module <<'NODE'\n([\s\S]*?)\n          NODE/u)?.[1];
assert.ok(guardBody, "execute the actual publication guard, not a duplicate policy implementation");
const guard = guardBody.split("\n").map((line) => line.replace(/^ {10}/u, "")).join("\n");

for (const scenario of [
	{ name: "browser-only with signing lane disabled", capability: "browser-only", lane: "", allowed: true, distribution: "none", checkoutCapability: "signed-v1" },
	{ name: "browser-only with optional signed assets enabled", capability: "browser-only", lane: "1", allowed: true, distribution: "signed", checkoutCapability: "adhoc-v1" },
	{ name: "ad-hoc without the signing lane", capability: "adhoc-v1", lane: "", allowed: true, distribution: "ad-hoc", checkoutCapability: "browser-only" },
	{ name: "ad-hoc remains free when the signed lane is enabled", capability: "adhoc-v1", lane: "1", allowed: true, distribution: "ad-hoc", checkoutCapability: "signed-v1" },
	{ name: "signed-v1 with signing lane disabled", capability: "signed-v1", lane: "", allowed: false, checkoutCapability: "browser-only", error: /require the enabled signed desktop publication lane/u },
	{ name: "signed-v1 with signing lane enabled", capability: "signed-v1", lane: "1", allowed: true, distribution: "signed", checkoutCapability: "invalid" },
	{ name: "unknown capability", capability: "invalid", lane: "1", allowed: false, checkoutCapability: "signed-v1", error: /Unknown desktop release capability/u },
	{ name: "legacy metadata without a capability", capability: undefined, lane: "", allowed: true, distribution: "none", checkoutCapability: "signed-v1" },
	{ name: "legacy metadata with optional signed assets enabled", capability: undefined, lane: "1", allowed: true, distribution: "signed", checkoutCapability: "adhoc-v1" },
]) {
	test(`immutable publication guard: ${scenario.name}`, async () => {
		const root = await mkdtemp(join(tmpdir(), "quarterdeck-default-capability-"));
		try {
			// Ignore inherited Git routing/configuration. Every object/ref mutation is
			// confined to this temporary repository, with no hooks or remote commands.
			const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/iu.test(key)));
			Object.assign(env, {
				HOME: root,
				USERPROFILE: root,
				QUARTERDECK_STATE_HOME: join(root, "state"),
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: join(root, "absent-global-config"),
				GIT_AUTHOR_NAME: "Quarterdeck Fixture",
				GIT_AUTHOR_EMAIL: "fixture@example.invalid",
				GIT_COMMITTER_NAME: "Quarterdeck Fixture",
				GIT_COMMITTER_EMAIL: "fixture@example.invalid",
			});
			const git = (args, input) => execFileSync("git", args, { cwd: root, env, input, encoding: "utf8", timeout: 10_000 }).trim();
			const templates = join(root, "empty-templates");
			await mkdir(templates);
			git(["init", "--quiet", `--template=${templates}`]);
			const metadata = { name: "quarterdeck", version: "0.0.123", ...(scenario.capability === undefined ? {} : { quarterdeck: { desktopRelease: scenario.capability } }) };
			const blob = git(["hash-object", "-w", "--stdin"], JSON.stringify(metadata));
			const tree = git(["mktree"], `100644 blob ${blob}\tpackage.json\n`);
			const commit = git(["commit-tree", tree, "-m", "Synthetic release metadata"]);
			git(["update-ref", "refs/tags/v0.0.123", commit]);
			const sourceSha = git(["rev-parse", "--verify", "refs/tags/v0.0.123^{commit}"]);
			assert.match(sourceSha, /^[a-f0-9]{40}$/u);
			// Deliberately contradictory working-tree metadata proves the guard reads
			// the immutable tag's resolved source, not the runner checkout's file.
			await writeFile(join(root, "package.json"), JSON.stringify({ quarterdeck: { desktopRelease: scenario.checkoutCapability } }));
			const outputPath = join(root, "workflow-output");
			const result = spawnSync(process.execPath, ["--input-type=module", "-e", guard], {
				cwd: root,
				env: { ...env, SOURCE_SHA: sourceSha, DESKTOP_RELEASES: scenario.lane, GITHUB_OUTPUT: outputPath },
				encoding: "utf8",
				timeout: 10_000,
			});
			assert.equal(result.error, undefined);
			assert.equal(result.signal, null);
			if (scenario.allowed) {
				assert.equal(result.status, 0, result.stderr);
				assert.equal(await readFile(outputPath, "utf8"), `desktop_mode=${scenario.distribution}\n`);
			} else {
				assert.notEqual(result.status, 0);
				assert.match(result.stderr, scenario.error);
				await assert.rejects(readFile(outputPath), { code: "ENOENT" });
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}
