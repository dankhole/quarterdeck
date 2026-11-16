import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sign } from "@electron/osx-sign";
import { describe, expect, it } from "vitest";
import { run } from "../scripts/process.mjs";
import {
	deferAdmissionExecutableToBundle,
	signingOptionsForFile,
	verifyAdHocIdentity,
} from "../scripts/signing-entitlements.mjs";

const helperNames = [
	"Quarterdeck",
	"Quarterdeck Helper",
	...["GPU", "Renderer", "Plugin", "Utility"].map((name) => `Quarterdeck Helper (${name})`),
];

async function unsignedBundle(parent, name) {
	const app = join(parent, `${name}.app`);
	const macos = join(app, "Contents", "MacOS");
	await mkdir(macos, { recursive: true });
	await writeFile(
		join(app, "Contents", "Info.plist"),
		`<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${name}</string>
<key>CFBundleIdentifier</key><string>io.github.dankhole.quarterdeck.signing-fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`,
	);
	const paths = [join(macos, name), join(macos, name.replace("Quarterdeck", "QuarterdeckHost"))];
	for (const path of paths) {
		await copyFile("/usr/bin/true", path);
		// Only synthetic copies: Intel upstream Electron hosts arrive unsigned.
		run("/usr/bin/codesign", ["--remove-signature", path], { stdio: "pipe" });
	}
	return { app, paths };
}

describe("native admission signing order", () => {
	it("defers only the known bundle main executables, not their hosts or bundle seals", () => {
		for (const name of helperNames) {
			const app = `/fixture/${name}.app`;
			expect(deferAdmissionExecutableToBundle(`${app}/Contents/MacOS/${name}`)).toBe(true);
			expect(
				deferAdmissionExecutableToBundle(`${app}/Contents/MacOS/${name.replace("Quarterdeck", "QuarterdeckHost")}`),
			).toBe(false);
			expect(deferAdmissionExecutableToBundle(app)).toBe(false);
		}
		for (const path of [
			"/fixture/Other.app/Contents/MacOS/Quarterdeck",
			"/fixture/Quarterdeck.app/Contents/Resources/runtime/bin/node",
			"/fixture/Quarterdeck.app/Contents/Resources/Quarterdeck",
			"/fixture/Quarterdeck Helper (Unknown).app/Contents/MacOS/Quarterdeck Helper (Unknown)",
		])
			expect(deferAdmissionExecutableToBundle(path)).toBe(false);
	});

	it.skipIf(process.platform !== "darwin")(
		"signs unsigned sibling hosts before sealing both app and helper, without deep-signing",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "quarterdeck-public-signing-order-"));
			try {
				const outer = await unsignedBundle(root, "Quarterdeck");
				const helper = await unsignedBundle(join(outer.app, "Contents", "Frameworks"), "Quarterdeck Helper (GPU)");
				const visited = [];
				const options = {
					app: outer.app,
					platform: "darwin",
					identity: "-",
					identityValidation: false,
					preAutoEntitlements: false,
					preEmbedProvisioningProfile: false,
					optionsForFile: (path) => {
						visited.push(path);
						return signingOptionsForFile(path, "ad-hoc");
					},
				};
				// osx-sign treats both MacOS siblings as main executables and orders
				// Quarterdeck before QuarterdeckHost, prematurely sealing the bundle.
				await expect(sign(options)).rejects.toThrow(/code object is not signed at all[\s\S]*QuarterdeckHost/u);
				visited.length = 0;
				await sign({ ...options, ignore: [deferAdmissionExecutableToBundle] });
				expect(visited).toContain(outer.app);
				expect(visited).toContain(helper.app);
				for (const [wrapper, host] of [outer.paths, helper.paths]) {
					expect(visited).not.toContain(wrapper);
					expect(visited).toContain(host);
					for (const path of [wrapper, host]) {
						const result = run("/usr/bin/codesign", ["--display", "--verbose=4", path], {
							stdio: "pipe",
							encoding: "utf8",
						});
						verifyAdHocIdentity(result.stderr);
					}
				}
				expect(() =>
					run("/usr/bin/codesign", ["--verify", "--deep", "--strict", outer.app], { stdio: "pipe" }),
				).not.toThrow();
				// A deferred wrapper is still signed and sealed; this is not an integrity exemption.
				const bytes = await readFile(helper.paths[0]);
				bytes[Math.floor(bytes.length / 2)] ^= 1;
				await writeFile(helper.paths[0], bytes);
				expect(() =>
					run("/usr/bin/codesign", ["--verify", "--deep", "--strict", outer.app], { stdio: "pipe" }),
				).toThrow();
				const verification = spawnSync(
					process.execPath,
					[
						"--input-type=module",
						"-e",
						`import {verifyAppSignature} from ${JSON.stringify(new URL("../scripts/app-signature.mjs", import.meta.url).href)}; verifyAppSignature(process.argv[1]);`,
						outer.app,
					],
					{
						encoding: "utf8",
						env: { ...process.env, QUARTERDECK_SYNTHETIC_SIGNING_SECRET: "do-not-log-this-synthetic-secret" },
					},
				);
				expect(verification.status).not.toBe(0);
				expect(verification.stderr).toMatch(/In subcomponent:.*Quarterdeck Helper \(GPU\)/u);
				expect(verification.stderr).not.toContain("do-not-log-this-synthetic-secret");
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);
});
