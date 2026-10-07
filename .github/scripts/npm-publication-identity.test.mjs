import assert from "node:assert/strict";
import { test } from "node:test";
import { getNpmPublicationState } from "./npm-publication-identity.mjs";

const release = { version: "0.12.9", sourceSha: "a".repeat(40) };
const response = (metadata, status = 0) => ({ status, signal: null, stdout: JSON.stringify(metadata) });

test("accepts a retry only for matching version and source, using bounded exact registry metadata", () => {
	const state = getNpmPublicationState(release, (command, args, options) => {
		assert.equal(command, "npm");
		assert.deepEqual(args, [
			"view", "quarterdeck@0.12.9", "version", "gitHead", "--json", "--registry=https://registry.npmjs.org",
		]);
		assert.equal(options.timeout, 60_000);
		assert.equal(options.maxBuffer, 65_536);
		return response({ version: release.version, gitHead: release.sourceSha });
	});
	assert.equal(state, "published");
});

test("only an explicit missing version permits first publication", () => {
	assert.equal(getNpmPublicationState(release, () => response({ error: { code: "E404" } }, 1)), "absent");
	for (const code of ["E401", "E403", "E429", "ECONNRESET", undefined]) {
		assert.throws(() => getNpmPublicationState(release, () => response({ error: { code } }, 1)), /safely determine/u);
	}
});

test("rejects an existing version from another or unknown source", () => {
	for (const metadata of [
		{ version: release.version, gitHead: "b".repeat(40) },
		{ version: release.version },
		{ version: "0.12.8", gitHead: release.sourceSha },
		{ version: release.version, gitHead: release.sourceSha.slice(0, 7) },
		release.version,
		[{ version: release.version, gitHead: release.sourceSha }],
		null,
	]) {
		assert.throws(() => getNpmPublicationState(release, () => response(metadata)), /does not match/u);
	}
});

test("refuses incomplete subprocess results even when stdout claims absence", () => {
	for (const override of [
		{ error: new Error("spawn failed") },
		{ signal: "SIGTERM" },
		{ status: null },
	]) {
		assert.throws(
			() => getNpmPublicationState(release, () => ({ ...response({ error: { code: "E404" } }, 1), ...override })),
			/safely determine/u,
		);
	}
	assert.throws(() => getNpmPublicationState(release, () => ({ status: 1, stdout: "not json" })), /invalid/u);
});

test("rejects version ranges, dist tags, and abbreviated source before invoking npm", () => {
	for (const input of [
		{ ...release, version: "latest" },
		{ ...release, version: "^0.12.9" },
		{ ...release, sourceSha: "abc1234" },
		{ ...release, sourceSha: undefined },
	]) {
		assert.throws(() => getNpmPublicationState(input, () => assert.fail("must not invoke npm")), /immutable/u);
	}
});
