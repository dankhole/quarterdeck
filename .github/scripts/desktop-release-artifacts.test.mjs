import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { artifactNames, checksum, validateRelease } from "./desktop-release-artifacts.mjs";

const version = "0.12.8";
const sha = "a".repeat(40);

async function fixture(run, productVersion = version) {
	const directory = await mkdtemp(join(tmpdir(), "quarterdeck-release-test-"));
	try {
		for (const arch of ["arm64", "x64"]) {
			const artifacts = [];
			for (const name of artifactNames(productVersion, arch)) {
				const path = join(directory, name);
				await writeFile(path, `${arch} synthetic container`);
				artifacts.push({
					path: name,
					bytes: Buffer.byteLength(`${arch} synthetic container`),
					sha256: await checksum(path),
				});
			}
			await writeFile(
				join(directory, `artifact-manifest-darwin-${arch}.json`),
				JSON.stringify({
					schemaVersion: 1,
					platform: "darwin",
					arch,
					version: productVersion,
					sourceSha: sha,
					sourceDirty: false,
					distribution: "signed-notarized",
					signedDistribution: true,
					expectedTeamId: "AB12345678",
					productionUpdatesEnabled: /^\d+\.\d+\.\d+$/u.test(productVersion),
					channel: productVersion.includes("-") ? "preview" : "stable",
					validationFeedBase: null,
					buildId: `${arch}-build`,
					electronVersion: "44.5.1",
					nodeVersion: "22.22.2",
					nodeAbi: "127",
					minimumMacOSVersion: "13.0",
					runtimeLockSha256: "b".repeat(64),
					nodeArchive: { sha256: "c".repeat(64) },
					checksums: Object.fromEntries(
						[
							"app.asar",
							"runtime/bin/node",
							"runtime/dist/cli.js",
							"runtime/dist/web-ui/index.html",
							"runtime/bundle-manifest.json",
							"runtime/release-policy.json",
						].map((resource) => [resource, "e".repeat(64)]),
					),
					fuses: {
						RunAsNode: false,
						EnableNodeOptionsEnvironmentVariable: false,
						EnableNodeCliInspectArguments: false,
						EnableCookieEncryption: true,
						EnableEmbeddedAsarIntegrityValidation: true,
						OnlyLoadAppFromAsar: true,
						GrantFileProtocolExtraPrivileges: false,
					},
					artifacts,
				}),
			);
		}
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function modify(directory, edit) {
	const path = join(directory, "artifact-manifest-darwin-arm64.json");
	const manifest = JSON.parse(await readFile(path, "utf8"));
	edit(manifest);
	await writeFile(path, JSON.stringify(manifest));
}

test("accepts both complete architectures with distinct paired build IDs", async () =>
	fixture(async (directory) => {
		assert.equal((await validateRelease(directory, version, sha)).length, 6);
	}));

test("rejects a dirty or differently sourced release", async () =>
	fixture(async (directory) => {
		await assert.rejects(validateRelease(directory, version, "d".repeat(40)), /identity mismatch/u);
		await modify(directory, (manifest) => {
			manifest.sourceDirty = true;
		});
		await assert.rejects(validateRelease(directory, version, sha), /Dirty source/u);
	}));

test("rejects unsigned and inspector-enabled candidates", async () =>
	fixture(async (directory) => {
		await modify(directory, (manifest) => {
			manifest.distribution = "unsigned-prototype";
		});
		await assert.rejects(validateRelease(directory, version, sha), /identity mismatch/u);
		await modify(directory, (manifest) => {
			manifest.distribution = "signed-notarized";
			manifest.fuses.EnableNodeCliInspectArguments = true;
		});
		await assert.rejects(validateRelease(directory, version, sha), /Unsafe/u);
	}));

test("rejects corrupted payload bytes", async () =>
	fixture(async (directory) => {
		await writeFile(join(directory, artifactNames(version, "arm64")[0]), "tampered");
		await assert.rejects(validateRelease(directory, version, sha), /checksum\/size mismatch/u);
	}));

test("rejects duplicate/path-traversal artifacts", async () =>
	fixture(async (directory) => {
		await modify(directory, (manifest) => {
			manifest.artifacts[1] = { ...manifest.artifacts[0] };
		});
		await assert.rejects(validateRelease(directory, version, sha), /Invalid artifact/u);
		await modify(directory, (manifest) => {
			manifest.artifacts[0].path = "../payload.dmg";
		});
		await assert.rejects(validateRelease(directory, version, sha), /Invalid artifact/u);
	}));

test("rejects a missing architecture", async () =>
	fixture(async (directory) => {
		await rm(join(directory, "artifact-manifest-darwin-x64.json"));
		await assert.rejects(validateRelease(directory, version, sha), { code: "ENOENT" });
	}));

test("rejects architecture runtime ABI disagreement", async () =>
	fixture(async (directory) => {
		await modify(directory, (manifest) => {
			manifest.nodeAbi = "999";
		});
		await assert.rejects(validateRelease(directory, version, sha), /Architecture nodeAbi mismatch/u);
	}));

test("requires signed update policy resource provenance", async () =>
	fixture(async (directory) => {
		await modify(directory, (manifest) => {
			delete manifest.checksums["runtime/release-policy.json"];
		});
		await assert.rejects(validateRelease(directory, version, sha), /Missing resource checksum/u);
	}));

test("refuses public promotion of feed-disabled, validation-channel, or unverified policy candidates", async () => {
	for (const change of [
		{ signedDistribution: false },
		{ expectedTeamId: null },
		{ expectedTeamId: "invalid" },
		{ productionUpdatesEnabled: false },
		{ channel: "validation", validationFeedBase: "https://updates.example/" },
		{ channel: "stable", validationFeedBase: "https://updates.example/" },
	])
		await fixture(async (directory) => {
			await modify(directory, (manifest) => Object.assign(manifest, change));
			await assert.rejects(validateRelease(directory, version, sha), /policy/u);
		});
});

test("requires the same actual signing team for both public architectures", async () =>
	fixture(async (directory) => {
		await modify(directory, (manifest) => {
			manifest.expectedTeamId = "ZY98765432";
		});
		await assert.rejects(validateRelease(directory, version, sha), /Architecture expectedTeamId mismatch/u);
	}));

test("public preview artifacts never enable the production update feed", async () => {
	const preview = "0.12.9-beta.1";
	await fixture(async (directory) => {
		assert.equal((await validateRelease(directory, preview, sha)).length, 6);
		await modify(directory, (manifest) => {
			manifest.productionUpdatesEnabled = true;
		});
		await assert.rejects(validateRelease(directory, preview, sha), /policy/u);
	}, preview);
});

test("requires safe version, architecture and exact source identifiers", async () => {
	assert.throws(() => artifactNames("../bad", "arm64"), /version/u);
	assert.throws(() => artifactNames(version, "universal"), /architecture/u);
	await assert.rejects(validateRelease("unused", version, "main"), /exact commit/u);
});
