import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { signingPreflight, signingSecrets, signingVariables } from "./desktop-signing-preflight.mjs";

const base = "repos/dankhole/quarterdeck";
const envBase = `${base}/environments/desktop-signing`;
function metadata() {
	return {
		[`${base}/environments?per_page=100`]: [{ environments: [{ name: "desktop-signing" }] }],
		[envBase]: {
			can_admins_bypass: false,
			protection_rules: [
				{
					type: "required_reviewers",
					prevent_self_review: false,
					reviewers: [{ type: "User", reviewer: { id: 1 } }],
				},
			],
			deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
		},
		[`${envBase}/deployment-branch-policies?per_page=100`]: [
			{
				branch_policies: [
					{ type: "branch", name: "main" },
					{ type: "tag", name: "v*.*.*" },
				],
			},
		],
		[`${envBase}/secrets?per_page=100`]: [{ secrets: signingSecrets.map((name) => ({ name })) }],
		[`${envBase}/variables?per_page=100`]: [
			{ variables: signingVariables.map((name) => ({ name, present: true, enabled: false })) },
		],
		[`${base}/actions/variables?per_page=100`]: [{ variables: [] }],
	};
}
function audit(fixture = metadata(), overrides = {}) {
	const calls = [];
	const result = signingPreflight({
		runGh(command, args, options) {
			calls.push(args);
			assert.equal(command, "gh");
			assert.equal(args[0], "api");
			assert.equal(args[args.indexOf("--method") + 1], "GET");
			assert.equal(options.stdio, "pipe");
			assert.equal(options.timeout, 30_000);
			const endpoint = args[1].replace(/&page=\d+$/u, "");
			assert.ok(Object.hasOwn(fixture, endpoint), `Unexpected endpoint ${args[1]}`);
			if (overrides[endpoint]) return overrides[endpoint];
			const value = fixture[endpoint];
			if (!Array.isArray(value)) return { status: 0, stdout: JSON.stringify(value) };
			const page = Number(args[1].match(/&page=(\d+)$/u)?.[1] ?? 1);
			const total = value.reduce((sum, item) => sum + Object.values(item).find(Array.isArray).length, 0);
			return { status: 0, stdout: JSON.stringify({ total_count: total, ...value[page - 1] }) };
		},
	});
	return { result, calls };
}
const status = (result, id) => result.checks.find((check) => check.id === id)?.status;

test("reports solo-maintainer metadata readiness only, using sanitized GETs", () => {
	const { result, calls } = audit();
	assert.equal(result.metadataReady, true);
	assert.equal(calls.length, 6);
	for (const args of calls.filter((args) => /\/(secrets|variables)\?/u.test(args[1]))) {
		assert.match(args[1], /per_page=100&page=1$/u);
		assert.ok(args.includes("--jq"));
		assert.doesNotMatch(args[args.indexOf("--jq") + 1], /\{[^}]*,\s*value\s*[,}]/u);
	}
	assert.equal(status(result, "environment-protection"), "pass");
	assert.match(result.checks.find((entry) => entry.id === "environment-protection").detail, /Solo-maintainer policy/u);
	assert.match(result.limitations.join(" "), /not independent review/u);
	assert.match(result.limitations.join(" "), /compromised maintainer account/u);
	assert.match(result.limitations.join(" "), /not permission to publish/u);
});

test("unknown self-review policy cannot establish solo-maintainer readiness", () => {
	for (const value of [undefined, null, "false", 0]) {
		const fixture = metadata();
		fixture[envBase].protection_rules[0].prevent_self_review = value;
		const { result } = audit(fixture);
		assert.equal(result.metadataReady, false);
		assert.equal(status(result, "environment-protection"), "unknown");
	}
});

test("identifies a missing environment from a successful list, without interpreting 404 as absence", () => {
	const fixture = metadata();
	fixture[`${base}/environments?per_page=100`] = [{ environments: [{ name: "npm-publish" }] }];
	const { result, calls } = audit(fixture);
	assert.equal(result.metadataReady, false);
	assert.equal(status(result, "environment-exists"), "fail");
	assert.equal(status(result, "environment-secrets"), "fail");
	assert.equal(calls.length, 2);
	const denied = audit(metadata(), {
		[`${base}/environments?per_page=100`]: { status: 1, stdout: "", stderr: "HTTP 404 sensitive error" },
	}).result;
	assert.equal(status(denied, "environment-exists"), "unknown");
	assert.equal(status(denied, "environment-secrets"), "unknown");
	assert.doesNotMatch(JSON.stringify(denied), /sensitive error/u);
});

test("secrets must be environment-scoped and variables must be nonblank", () => {
	const fixture = metadata();
	fixture[`${envBase}/secrets?per_page=100`][0].secrets.pop();
	fixture[`${envBase}/variables?per_page=100`][0].variables[0].present = false;
	const { result } = audit(fixture);
	assert.equal(result.metadataReady, false);
	assert.equal(status(result, "environment-secrets"), "fail");
	assert.equal(status(result, "environment-variables"), "fail");
	assert.match(JSON.stringify(result), /DESKTOP_MAC_NOTARY_KEY_BASE64/u);
});

test("combines paginated results", () => {
	const fixture = metadata();
	fixture[`${envBase}/secrets?per_page=100`] = [
		{ secrets: Array.from({ length: 100 }, (_, index) => ({ name: `UNRELATED_${index}` })) },
		{ secrets: signingSecrets.map((name) => ({ name })) },
	];
	assert.equal(audit(fixture).result.metadataReady, true);
});

for (const [label, mutate] of [
	[
		"admin bypass",
		(fixture) => {
			fixture[envBase].can_admins_bypass = true;
		},
	],
	[
		"self-review blocked under selected solo policy",
		(fixture) => {
			fixture[envBase].protection_rules[0].prevent_self_review = true;
		},
	],
	[
		"no reviewers",
		(fixture) => {
			fixture[envBase].protection_rules[0].reviewers = [];
		},
	],
	[
		"missing required-reviewer approval rule",
		(fixture) => {
			fixture[envBase].protection_rules = [];
		},
	],
	[
		"protected branches without exact custom restrictions",
		(fixture) => {
			fixture[envBase].deployment_branch_policy = { protected_branches: true, custom_branch_policies: false };
		},
	],
	[
		"broad ref policy",
		(fixture) => {
			fixture[`${envBase}/deployment-branch-policies?per_page=100`][0].branch_policies.push({
				type: "branch",
				name: "*",
			});
		},
	],
	[
		"untyped ref policy",
		(fixture) => {
			delete fixture[`${envBase}/deployment-branch-policies?per_page=100`][0].branch_policies[0].type;
		},
	],
	[
		"enabled publication",
		(fixture) => {
			fixture[`${base}/actions/variables?per_page=100`][0].variables.push({
				name: "QUARTERDECK_DESKTOP_RELEASES",
				enabled: true,
			});
		},
	],
]) {
	test(`fails closed for ${label}`, () => {
		const fixture = metadata();
		mutate(fixture);
		assert.equal(audit(fixture).result.metadataReady, false);
	});
}

for (const failure of [
	{ status: 1, stdout: "", stderr: "DO_NOT_PRINT_CREDENTIAL_MATERIAL" },
	{ status: 0, stdout: "not JSON DO_NOT_PRINT_CREDENTIAL_MATERIAL" },
	{ status: null, signal: "SIGTERM", stdout: "" },
	{ status: 0, error: new Error("DO_NOT_PRINT_CREDENTIAL_MATERIAL"), stdout: "{}" },
	{ status: 0, stdout: "{}" },
	{ status: 0, stdout: "[]" },
]) {
	test(`failed/unknown API result cannot pass: ${String(failure.status)} ${String(failure.signal)}`, () => {
		const { result } = audit(metadata(), { [`${envBase}/variables?per_page=100`]: failure });
		assert.equal(result.metadataReady, false);
		assert.equal(status(result, "environment-variables"), "unknown");
		assert.doesNotMatch(JSON.stringify(result), /DO_NOT_PRINT_CREDENTIAL_MATERIAL/u);
	});
}

test("refuses incomplete or changing pagination instead of inferring missing settings", () => {
	for (const response of [
		{ total_count: 2, variables: [{ name: "unrelated", enabled: false }] },
		{ total_count: 0, variables: [{ name: "unrelated", enabled: false }] },
		{ total_count: 1, variables: [{}] },
	]) {
		const { result } = audit(metadata(), {
			[`${base}/actions/variables?per_page=100`]: { status: 0, stdout: JSON.stringify(response) },
		});
		assert.equal(status(result, "publication-disabled"), "unknown");
		assert.equal(result.metadataReady, false);
	}
});

test("rejects malformed repository arguments before invoking gh", () => {
	assert.throws(
		() =>
			signingPreflight({
				repository: "--hostname evil",
				runGh() {
					assert.fail("Must not run");
				},
			}),
		/owner\/repository/u,
	);
});

const workflow = await readFile(new URL("../workflows/desktop-release.yml", import.meta.url), "utf8");
function stepScript(name) {
	const block = workflow.split(`      - name: ${name}\n`)[1]?.split("\n      - ")[0];
	assert.ok(block, `Missing step: ${name}`);
	return block
		.split("        run: |\n")[1]
		.split("\n")
		.map((line) => (line.startsWith("          ") ? line.slice(10) : line))
		.join("\n");
}

// Source-only Bash fixtures: no Apple tools or real signing credentials run.
// Windows still runs every metadata and static-workflow assertion, without
// depending on Git Bash or translating Windows-native temporary paths.
const bashFixture = { skip: process.platform === "win32" ? "Bash workflow fixture requires a POSIX host" : false };

test("workflow run blocks remain valid bash", bashFixture, () => {
	for (const block of workflow.split("        run: |\n").slice(1)) {
		const lines = block.split("\n");
		const end = lines.findIndex((line) => line.trim() && !line.startsWith("          "));
		const script = (end < 0 ? lines : lines.slice(0, end)).map((line) => line.slice(10)).join("\n");
		const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	}
});

test("workflow preserves signing/verification safety boundaries", () => {
	assert.match(workflow, /persist-credentials: false/u);
	assert.match(workflow, /git merge-base --is-ancestor/u);
	assert.match(workflow, /codesign --verify --deep --strict/u);
	assert.doesNotMatch(workflow, /codesign[^\n]*--deep[^\n]*--sign/u);
	assert.match(workflow, /xcrun stapler validate "\$final_dmg"/u);
	assert.match(workflow, /if: always\(\)/u);
	assert.doesNotMatch(workflow, /contents: write|gh release|npm publish/u);
});

test("workflow validates signing identifiers without printing their values", bashFixture, () => {
	const script = stepScript("Validate public signing configuration before building");
	const env = {
		...process.env,
		SIGNING_IDENTITY: "Developer ID Application: Synthetic (AB12345678)",
		TEAM_ID: "AB12345678",
		NOTARY_KEY_ID: "AB12345678",
		NOTARY_ISSUER: "a".repeat(8) + "-aaaa-aaaa-aaaa-" + "a".repeat(12),
	};
	assert.equal(spawnSync("bash", ["-e", "-c", script], { env, encoding: "utf8" }).status, 0);
	const result = spawnSync("bash", ["-e", "-c", script], {
		env: { ...env, TEAM_ID: "DO_NOT_PRINT_THIS" },
		encoding: "utf8",
	});
	assert.notEqual(result.status, 0);
	assert.doesNotMatch(result.stdout + result.stderr, /DO_NOT_PRINT_THIS/u);
});

test("cleanup removes exported material even if keychain deletion fails", bashFixture, async () => {
	const directory = await mkdtemp(join(tmpdir(), "quarterdeck-signing-cleanup-test-"));
	try {
		const signing = join(directory, "signing");
		await mkdir(signing);
		for (const name of ["signing.keychain-db", "quarterdeck-certificate.p12", "quarterdeck-notary.p8"])
			await writeFile(join(signing, name), "synthetic fixture, not credentials");
		const script = `security() { return 1; }\n${stepScript("Remove signing materials")}`;
		const result = spawnSync("bash", ["-e", "-c", script], {
			encoding: "utf8",
			env: {
				...process.env,
				QUARTERDECK_DESKTOP_SIGNING_DIR: signing,
				QUARTERDECK_DESKTOP_SIGNING_KEYCHAIN: join(signing, "signing.keychain-db"),
			},
		});
		assert.equal(result.status, 1);
		await assert.rejects(readFile(join(signing, "quarterdeck-certificate.p12")), { code: "ENOENT" });
		await assert.rejects(readFile(join(signing, "quarterdeck-notary.p8")), { code: "ENOENT" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
