import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { readBuildManifest, readSourceIdentity, validateBuildManifest } from "../../scripts/build-manifest.mjs";
import { artifactNames, checksum, validateRelease } from "./desktop-release-artifacts.mjs";
import {
	downloadAnonymous,
	findRelease,
	publishDesktopRelease,
	releaseChecksums,
	verifyPublicRelease,
} from "./desktop-publication.mjs";

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
					updateAuthority: "npm",
					channel: productVersion.includes("-") ? "preview" : "stable",
					buildId: `${arch}-build`,
					electronVersion: "44.5.1",
					nodeVersion: "22.22.2",
					nodeAbi: "127",
					minimumMacOSVersion: "13.0",
					runtimeLockSha256: "b".repeat(64),
					nativeAdmission: { schemaVersion: 1, bootstrapSha256: "a".repeat(64), hostSha256: "b".repeat(64) },
					nodeArchive: { sha256: "c".repeat(64) },
					checksums: Object.fromEntries(
						[
							"app.asar",
							"runtime/bin/node",
		"runtime/bin/nodeHost",
							"runtime/dist/cli.js",
							"runtime/dist/build-manifest.json",
							"runtime/installation-admission",
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

test("requires signed installation policy resource provenance", async () =>
	fixture(async (directory) => {
		await modify(directory, (manifest) => {
			delete manifest.checksums["runtime/release-policy.json"];
		});
		await assert.rejects(validateRelease(directory, version, sha), /Missing resource checksum/u);
	}));

test("refuses public promotion with obsolete updater fields or incorrect distribution policy", async () => {
	for (const change of [
		{ signedDistribution: false },
		{ expectedTeamId: null },
		{ expectedTeamId: "invalid" },
		{ updateAuthority: "electron" },
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

test("public preview artifacts reject obsolete updater metadata", async () => {
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

test("requires native bootstrap and installer helper provenance", async () =>
	fixture(async (directory) => {
		await modify(directory, (manifest) => {
			delete manifest.nativeAdmission;
		});
		await assert.rejects(validateRelease(directory, version, sha), /native admission provenance/u);
	}));

const releaseIdentity = { repository: "dankhole/quarterdeck", version, sourceSha: sha };

test("release inspection distinguishes missing releases from API failure", () => {
	assert.equal(
		findRelease(releaseIdentity, () => "[[]]"),
		null,
	);
	assert.equal(
		findRelease(releaseIdentity, () => JSON.stringify([[{ id: 1, tag_name: `v${version}`, draft: false }]])).draft,
		false,
	);
	assert.throws(
		() =>
			findRelease(releaseIdentity, () => {
				throw new Error("auth unavailable");
			}),
		/auth unavailable/u,
	);
	assert.throws(() => findRelease(releaseIdentity, () => "{}"), /Invalid GitHub/u);
});

test("public retry reuses downloaded bytes without any release mutation or local candidate", async () => {
	const calls = [];
	await publishDesktopRelease(
		{ ...releaseIdentity, directory: "/missing", publicDirectory: "/public" },
		{
			inspect: () => ({ id: 1, draft: false }),
			execute: () => {
				throw new Error("Public retries cannot mutate GitHub.");
			},
			verifyPublic: async (options, directory) => {
				calls.push([options.sourceSha, directory]);
			},
		},
	);
	assert.deepEqual(calls, [[sha, "/public"]]);
});

test("draft retries generate notes for the exact source before promotion and public verification", async () =>
	fixture(async (directory) => {
		const calls = [];
		const body = "## What's Changed\n* Preserve saved work by @contributor in #123\n";
		await publishDesktopRelease(
			{ ...releaseIdentity, directory, publicDirectory: "/public" },
			{
				inspect: () => ({ id: 1, draft: true }),
				execute: (args) => {
					calls.push(args);
					if (args[0] === "api") return JSON.stringify({ body });
				},
				verifyPublic: async () => {
					calls.push(["verified-public"]);
				},
			},
		);
		assert.deepEqual(calls[0], [
			"api",
			"repos/dankhole/quarterdeck/releases/generate-notes",
			"--method",
			"POST",
			"--raw-field",
			`tag_name=v${version}`,
			"--raw-field",
			`target_commitish=${sha}`,
		]);
		assert.equal(calls[1][1], "upload");
		assert.ok(calls[1].includes("--clobber"));
		assert.equal(calls[2][1], "edit");
		assert.ok(calls[2].includes("--prerelease=false"));
		const notesPath = calls[2][calls[2].indexOf("--notes-file") + 1];
		assert.equal(await readFile(notesPath, "utf8"), body);
		assert.deepEqual(calls[3], ["verified-public"]);
	}));

test("new prereleases create a verified-tag draft with generated notes before uploading assets", async () => {
	const preview = "0.12.9-beta.1";
	await fixture(async (directory) => {
		const calls = [];
		let inspections = 0;
		await publishDesktopRelease(
			{ ...releaseIdentity, version: preview, directory, publicDirectory: "/public" },
			{
				inspect: () => (++inspections === 1 ? null : { id: 1, draft: true }),
				execute: (args) => {
					calls.push(args);
					if (args[0] === "api") return JSON.stringify({ body: "Generated preview notes" });
				},
				verifyPublic: async () => calls.push(["verified-public"]),
			},
		);
		assert.ok(calls[0].includes(`tag_name=v${preview}`));
		assert.equal(calls[1][1], "create");
		assert.equal(calls[1][2], `v${preview}`);
		assert.ok(calls[1].includes("--verify-tag"));
		assert.ok(calls[1].includes("--draft"));
		const notesPath = calls[1][calls[1].indexOf("--notes-file") + 1];
		assert.equal(await readFile(notesPath, "utf8"), "Generated preview notes");
		assert.equal(calls[2][1], "upload");
		assert.equal(calls[3][1], "edit");
		assert.ok(calls[3].includes("--prerelease=true"));
		assert.equal(calls[3][calls[3].indexOf("--notes-file") + 1], notesPath);
		assert.deepEqual(calls[4], ["verified-public"]);
	}, preview);
});

test("failed or invalid GitHub note generation cannot create, upload, or promote a release", async () => {
	for (const response of ["{", "null", "{}", '{"body":null}', '{"body":"  "}', new Error("API unavailable")]) {
		await fixture(async (directory) => {
			const calls = [];
			await assert.rejects(
				publishDesktopRelease(
					{ ...releaseIdentity, directory },
					{
						inspect: () => null,
						execute: (args) => {
							calls.push(args[0]);
							if (response instanceof Error) throw response;
							return response;
						},
						verifyPublic: async () => calls.push("verified-public"),
					},
				),
			);
			assert.deepEqual(calls, ["api"]);
		});
	}
});

test("a candidate cannot replace a release promoted by another actor", async () =>
	fixture(async (directory) => {
		let inspections = 0;
		await assert.rejects(
			publishDesktopRelease(
				{ ...releaseIdentity, directory },
				{
					inspect: () => ({ id: 1, draft: ++inspections === 1 }),
					execute: (args) => {
						if (args[0] === "api") return JSON.stringify({ body: "Generated notes" });
						throw new Error("Must not mutate public release.");
					},
				},
			),
			/no longer draft/u,
		);
	}));

test("anonymous full release verification binds every manifest and container to SHA256SUMS", async () =>
	fixture(async (directory) => {
		const files = await validateRelease(directory, version, sha);
		await writeFile(join(directory, "SHA256SUMS"), await releaseChecksums(files));
		const destination = await mkdtemp(join(tmpdir(), "quarterdeck-public-test-"));
		try {
			const seen = [];
			const download = async (url, path) => {
				seen.push(url);
				await writeFile(path, await readFile(join(directory, basename(path))));
			};
			await verifyPublicRelease(releaseIdentity, destination, download);
			assert.equal(seen.length, 7);
			await writeFile(join(directory, "SHA256SUMS"), "wrong\n");
			await assert.rejects(verifyPublicRelease(releaseIdentity, destination, download), /Public SHA256SUMS/u);
		} finally {
			await rm(destination, { recursive: true, force: true });
		}
	}));

test("anonymous download rejects unsafe redirects and bounded truncated assets", async () => {
	const directory = await mkdtemp(join(tmpdir(), "quarterdeck-download-test-"));
	try {
		await assert.rejects(
			downloadAnonymous(
				"https://github.com/start",
				join(directory, "redirect"),
				10,
				async () => new Response(null, { status: 302, headers: { location: "https://attacker.example/file" } }),
			),
			/Unsafe anonymous/u,
		);
		await assert.rejects(
			downloadAnonymous("https://github.com/start", join(directory, "large"), 1, async () => new Response("long")),
			/size limit/u,
		);
		await assert.rejects(
			downloadAnonymous(
				"https://github.com/start",
				join(directory, "truncated"),
				10,
				async () => new Response("x", { headers: { "content-length": "5" } }),
			),
			/Incomplete/u,
		);
		await downloadAnonymous("https://github.com/start", join(directory, "okay"), 10, async (_url, options) => {
			assert.deepEqual(Object.keys(options.headers), ["Accept"]);
			assert.equal(options.redirect, "manual");
			return new Response("good");
		});
		assert.equal(await readFile(join(directory, "okay"), "utf8"), "good");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("root build provenance requires exact source, paired UUID, version, and dirtiness", async () => {
	const manifest = {
		schemaVersion: 1,
		version,
		sourceSha: sha,
		buildId: "28fa4d43-2a02-4942-9bf1-aa23955764cf",
		sourceDirty: false,
	};
	assert.equal(validateBuildManifest(manifest), manifest);
	for (const change of [
		{ schemaVersion: 2 },
		{ version: "latest" },
		{ version: 123 },
		{ buildId: "stale" },
		{ sourceSha: "main" },
		{ sourceDirty: undefined },
	])
		assert.throws(() => validateBuildManifest({ ...manifest, ...change }), /invalid root build provenance/u);
	const directory = await mkdtemp(join(tmpdir(), "quarterdeck-build-test-"));
	try {
		if (process.platform !== "win32") {
			await writeFile(join(directory, "actual.json"), JSON.stringify(manifest));
			await symlink(join(directory, "actual.json"), join(directory, "build-manifest.json"));
			await assert.rejects(readBuildManifest(directory), /bounded real file/u);
			await rm(join(directory, "build-manifest.json"));
		}
		await writeFile(join(directory, "build-manifest.json"), " ".repeat(16 * 1024 + 1));
		await assert.rejects(readBuildManifest(directory), /bounded real file/u);
		await writeFile(join(directory, "build-manifest.json"), JSON.stringify(manifest));
		assert.deepEqual(await readBuildManifest(directory), manifest);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
	assert.deepEqual(
		readSourceIdentity("/synthetic", (_command, args) => ({
			status: 0,
			stdout: args[0] === "rev-parse" ? sha : " M source.ts",
		})),
		{ sourceSha: sha, sourceDirty: true },
	);
	assert.throws(() => readSourceIdentity("/synthetic", () => ({ status: 1, stdout: sha })), /Git source identity/u);
});
