import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { desktopResourcePathsForPlatform } from "../../desktop/scripts/desktop-resource-paths.mjs";
import { readBuildManifest, readSourceIdentity, validateBuildManifest } from "../../scripts/build-manifest.mjs";
import { artifactNames, checksum, validateRelease } from "./desktop-release-artifacts.mjs";
import {
	downloadAnonymous,
	findRelease,
	publishRelease,
	releaseChecksums,
	verifyPublicRelease,
} from "./desktop-publication.mjs";

const version = "0.12.8";
const sha = "a".repeat(40);

async function fixture(run, productVersion = version, distribution = "signed-notarized") {
	const directory = await mkdtemp(join(tmpdir(), "quarterdeck-release-test-"));
	try {
		for (const targetDistribution of distribution === "windows-unsigned" ? [distribution] : [distribution, "windows-unsigned"]) {
			const distribution = targetDistribution;
			const platform = distribution === "windows-unsigned" ? "win32" : "darwin";
			for (const arch of ["arm64", "x64"]) {
				const artifacts = [];
				for (const name of artifactNames(productVersion, arch,platform)) {
					const path = join(directory, name);
					await writeFile(path, `${arch} synthetic container`);
					artifacts.push({
						path: name,
						bytes: Buffer.byteLength(`${arch} synthetic container`),
						sha256: await checksum(path),
					});
				}
				await writeFile(
					join(directory, `artifact-manifest-${platform}-${arch}.json`),
					JSON.stringify({
						schemaVersion: 1,
						platform,
						arch,
						version: productVersion,
						sourceSha: sha,
						sourceDirty: false,
						distribution,
						distributionMode: distribution === "signed-notarized"?"signed":distribution,
						signedDistribution: distribution === "signed-notarized",
						expectedTeamId: distribution === "signed-notarized"?"AB12345678":null,
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
						checksums: Object.fromEntries(desktopResourcePathsForPlatform(platform).map((resource) => [resource, "e".repeat(64)])),
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

test("accepts explicit public ad-hoc policy, never as an implicit signed release", async () =>
	fixture(
		async (directory) => {
			assert.equal((await validateRelease(directory, version, sha, "ad-hoc")).length, 6);
			await assert.rejects(validateRelease(directory, version, sha), /identity mismatch/u);
			for (const change of [
				{ sourceDirty: true },
				{ distributionMode: "local" },
				{ distributionMode: undefined },
				{ signedDistribution: true },
				{ expectedTeamId: "AB12345678" },
				{ distribution: "unsigned-prototype" },
				{ distribution: "ad-hoc-prototype-unverified" },
				{ fuses: { EnableNodeCliInspectArguments: true } },
			]) {
				const path = join(directory, "artifact-manifest-darwin-arm64.json");
				const original = await readFile(path, "utf8");
				await writeFile(path, JSON.stringify({ ...JSON.parse(original), ...change }));
				await assert.rejects(validateRelease(directory, version, sha, "ad-hoc"));
				await writeFile(path, original);
			}
		},
		version,
		"ad-hoc",
	));

test("retains legacy absent mode for signed releases but rejects cross-architecture policy changes", async () =>
	fixture(async (directory) => {
		for (const arch of ["arm64", "x64"]) {
			const path = join(directory, `artifact-manifest-darwin-${arch}.json`);
			const manifest = JSON.parse(await readFile(path, "utf8"));
			delete manifest.distributionMode;
			await writeFile(path, JSON.stringify(manifest));
		}
		assert.equal((await validateRelease(directory, version, sha)).length, 6);
		await modify(directory, (manifest) => {
			manifest.distribution = "ad-hoc";
			manifest.distributionMode = "ad-hoc";
			manifest.signedDistribution = false;
			manifest.expectedTeamId = null;
		});
		await assert.rejects(validateRelease(directory, version, sha), /identity mismatch/u);
		await assert.rejects(validateRelease(directory, version, sha, "ad-hoc"), /identity mismatch/u);
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

test("removed platform opt-outs cannot publish or verify browser-only or partial releases", async () => {
	for (const selection of [{ desktop: false }, { desktop: undefined }, { windows: false }, { windows: undefined }]) {
		const options = { ...releaseIdentity, ...selection, directory: "/missing", publicDirectory: "/public" };
		await assert.rejects(publishRelease(options, {
			inspect: () => assert.fail("Removed opt-outs must fail before inspecting a release."),
			execute: () => assert.fail("Removed opt-outs must never mutate a release."),
		}), /platform opt-outs are removed/u);
		await assert.rejects(verifyPublicRelease(options, "/missing", async () => assert.fail("Must not download.")), /platform opt-outs are removed/u);
	}
	for (const expectedDistribution of ["browser-only", "none", "windows-unsigned"]) {
		await assert.rejects(publishRelease({ ...releaseIdentity, expectedDistribution }), /public macOS/u);
	}
});

test("publication CLI rejects platform opt-out flags before any GitHub access", () => {
	for (const flag of ["--no-desktop", "--no-windows"]) {
		const result = spawnSync(process.execPath, [fileURLToPath(new URL("./desktop-publication.mjs", import.meta.url)), "publish", flag], { encoding: "utf8", timeout: 10_000 });
		assert.equal(result.error, undefined);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Unknown option/u);
	}
});

test("an incomplete public release cannot gain missing desktop assets under an immutable tag", async () => {
	await assert.rejects(
		publishRelease(
			{ ...releaseIdentity, directory: "/missing", publicDirectory: "/public" },
			{
				inspect: () => ({ id: 1, draft: false, assets: [] }),
				execute: () => assert.fail("A public release cannot gain new desktop assets."),
				verifyPublic: async () => {
					throw new Error("Missing public signed assets");
				},
			},
		),
		/Missing public signed assets/u,
	);
});

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
	await publishRelease(
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
		await publishRelease(
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
		await publishRelease(
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
				publishRelease(
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
			publishRelease(
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
		const files = [...await validateRelease(directory, version, sha), ...await validateRelease(directory, version, sha, "windows-unsigned")];
		await writeFile(join(directory, "SHA256SUMS"), await releaseChecksums(files));
		const destination = await mkdtemp(join(tmpdir(), "quarterdeck-public-test-"));
		try {
			const seen = [];
			const download = async (url, path) => {
				seen.push(url);
				await writeFile(path, await readFile(join(directory, basename(path))));
			};
			await verifyPublicRelease(releaseIdentity, destination, download);
			assert.equal(seen.length, 11);
			await writeFile(join(directory, "SHA256SUMS"), "wrong\n");
			await assert.rejects(verifyPublicRelease(releaseIdentity, destination, download), /Public SHA256SUMS/u);
		} finally {
			await rm(destination, { recursive: true, force: true });
		}
	}));

test("public ad-hoc draft promotion and immutable retry preserve explicit expected distribution", async () =>
	fixture(
		async (directory) => {
			const expectedDistribution = "ad-hoc";
			for (const draft of [true, false]) {
				let verified = false;
				await publishRelease(
					{ ...releaseIdentity, expectedDistribution, directory, publicDirectory: "/synthetic-public" },
					{
						inspect: () => ({ id: 1, draft }),
						execute: (args) => {
							assert.equal(draft, true, "Immutable public retry cannot mutate GitHub");
							if (args[0] === "api")
								return JSON.stringify({ body: "Public ad-hoc release, no notarization claims" });
						},
						verifyPublic: async (options) => {
							assert.equal(options.expectedDistribution, expectedDistribution);
							verified = true;
						},
					},
				);
				assert.equal(verified, true);
			}
		},
		version,
		"ad-hoc",
	));

test("anonymous retries reject signed/ad-hoc swaps in either direction without mutating public assets", async () => {
	for (const actual of ["signed-notarized", "ad-hoc"]) {
		await fixture(
			async (directory) => {
				const files = [...await validateRelease(directory, version, sha, actual), ...await validateRelease(directory, version, sha, "windows-unsigned")];
				await writeFile(join(directory, "SHA256SUMS"), await releaseChecksums(files));
				const destination = await mkdtemp(join(tmpdir(), "quarterdeck-distribution-retry-"));
				try {
					const download = async (_url, path) => writeFile(path, await readFile(join(directory, basename(path))));
					await verifyPublicRelease({ ...releaseIdentity, expectedDistribution: actual }, destination, download);
					await assert.rejects(
						publishRelease(
							{
								...releaseIdentity,
								expectedDistribution: actual === "ad-hoc" ? "signed-notarized" : "ad-hoc",
								directory: "/missing",
								publicDirectory: destination,
							},
							{
								inspect: () => ({ id: 1, draft: false }),
								execute: () => assert.fail("No mutations allowed for an immutable public release"),
								verifyPublic: (options, path) => verifyPublicRelease(options, path, download),
							},
						),
						/identity mismatch/u,
					);
				} finally {
					await rm(destination, { recursive: true, force: true });
				}
			},
			version,
			actual,
		);
	}
});

test("ad-hoc publication uses a separate credential-free native lane and explicit expected policies", async () => {
	const free = await readFile(new URL("../workflows/desktop-adhoc-release.yml", import.meta.url), "utf8");
	const publish = await readFile(new URL("../workflows/publish.yml", import.meta.url), "utf8");
	assert.doesNotMatch(
		free,
		/secrets\.|secrets:|environment:|notarytool|stapler|spctl|--remove-signature|xattr|contents: write|npm publish/u,
	);
	for (const required of [
		"macos-15",
		"macos-15-intel",
		'node-version: "22.23.2"',
		"npm@11.19.1",
		"QUARTERDECK_DESKTOP_DISTRIBUTION: ad-hoc",
		"codesign --verify --deep --strict",
		"--distribution ad-hoc",
		"git merge-base --is-ancestor",
		'"$GITHUB_REPOSITORY" == dankhole/quarterdeck',
		"refs/heads/main",
	])
		assert.ok(free.includes(required), required);
	const lane = publish.split("  desktop-adhoc:\n")[1]?.split("\n  desktop-assets:")[0];
	assert.ok(lane);
	assert.doesNotMatch(lane, /secrets:|environment:/u);
	assert.match(lane, /desktop_mode == 'ad-hoc'/u);
	assert.match(publish, /ad-hoc\) desktop_args\+=\(--distribution ad-hoc\)/u);
	assert.match(publish, /signed\) desktop_args\+=\(--distribution signed-notarized\)/u);
	assert.match(publish, /needs: \[resolve, test, desktop, desktop-adhoc, desktop-windows\]/u);
});

test("shared CI has no standalone browser lane and desktop CI retains native packaged smoke", async () => {
	const shared = await readFile(new URL("../workflows/test.yml", import.meta.url), "utf8");
	const desktop = await readFile(new URL("../workflows/desktop-ci.yml", import.meta.url), "utf8");
	for (const workflow of [shared, desktop])
		assert.doesNotMatch(workflow, /web:smoke:production|web:e2e|agent:browser|playwright install|install-browser chromium/u);
	for (const required of ["ubuntu-latest", "npm run test:package", "npm run check", "npm run web:test"])
		assert.ok(shared.includes(required), required);
	for (const required of ["macos-15", "macos-15-intel", "windows-latest", "windows-11-arm"])
		assert.ok(desktop.includes(required), required);
	assert.equal((desktop.match(/agent:desktop -- smoke/gu) ?? []).length, 2, "Both native platform jobs must exercise their packaged app.");
});

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


test("Windows publication requires both unsigned native ZIPs alongside macOS assets", async () => fixture(async directory => {
	assert.equal((await validateRelease(directory, version, sha, "windows-unsigned")).length, 4);
	const calls = [];
	let verified = false;
	await publishRelease({ ...releaseIdentity, desktop: true, windows: true, directory, publicDirectory: join(directory, "verified") }, {
		inspect: () => ({ id: 1, draft: true, assets: [] }),
		execute: args => { calls.push(args); if (args[0] === "api") return JSON.stringify({ body: "Generated desktop release notes" }); },
		verifyPublic: async () => { verified = true; },
	});
	assert.ok(verified);
	const upload = calls.find(args => args[1] === "upload");
	for (const platform of ["darwin", "win32"])
		for (const arch of ["arm64", "x64"])
			assert.ok(upload.some(value => value.endsWith(`artifact-manifest-${platform}-${arch}.json`)));
	for (const platform of ["darwin", "win32"]) {
		for (const arch of ["arm64", "x64"]) {
			const manifest = join(directory, `artifact-manifest-${platform}-${arch}.json`);
			const original = await readFile(manifest);
			await rm(manifest);
			await assert.rejects(publishRelease({ ...releaseIdentity, directory }, {
				inspect: () => ({ id: 1, draft: true }),
				execute: () => assert.fail("Missing native assets must fail before any mutation."),
			}), { code: "ENOENT" });
			await writeFile(manifest, original);
		}
	}
}));
