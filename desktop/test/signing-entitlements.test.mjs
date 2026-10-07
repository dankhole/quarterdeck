import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { desktopRoot } from "../scripts/paths.mjs";
import {
	entitlementClass,
	signingOptionsForFile,
	verifyDeveloperIdIdentity,
	verifyEntitlementDictionary,
	verifySignedAppEntitlements,
} from "../scripts/signing-entitlements.mjs";

const allowJit = "com.apple.security.cs.allow-jit";
const signature =
	"Authority=Developer ID Application: Synthetic Developer (AB12345678)\nTeamIdentifier=AB12345678\nCodeDirectory v=20500 flags=0x10000(runtime) hashes=10\n";

async function fixture() {
	const cache = join(desktopRoot, ".cache");
	await mkdir(cache, { recursive: true });
	const root = await mkdtemp(join(cache, "entitlements-test-"));
	const app = join(root, "Quarterdeck.app");
	const files = [
		"Contents/MacOS/Quarterdeck",
		"Contents/Resources/runtime/bin/node",
		"Contents/Resources/runtime/node_modules/node-pty/build/Release/pty.node",
		"Contents/Resources/runtime/node_modules/node-pty/build/Release/spawn-helper",
		"Contents/Frameworks/Quarterdeck Helper (Plugin).app/Contents/MacOS/Quarterdeck Helper (Plugin)",
		"Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
	];
	for (const file of files) {
		await mkdir(dirname(join(app, file)), { recursive: true });
		await writeFile(join(app, file), Buffer.from("cffaedfe00000000", "hex"));
	}
	await writeFile(join(app, "Contents/Resources/plain.txt"), "not executable");
	await symlink(join(root, "unvisited"), join(app, "Contents/Resources/alias"));
	return { root, app, files };
}

function syntheticSigner(extra = {}, identity = signature) {
	const visited = [];
	const runCommand = (command, args, options) => {
		if (command === "/usr/bin/plutil") return { stdout: options.input, stderr: "" };
		const target = args.at(-1);
		visited.push({ args, target });
		if (args.includes("--entitlements")) {
			const dictionary = entitlementClass(target) === "library" ? {} : { [allowJit]: true };
			return { stdout: JSON.stringify({ ...dictionary, ...extra }), stderr: "" };
		}
		return { stdout: "", stderr: identity };
	};
	return { visited, runCommand };
}

describe("minimal Developer ID entitlements", () => {
	it("overrides every signing default with JIT-only processes and empty libraries", () => {
		for (const path of [
			"/bundle/Quarterdeck.app",
			"/bundle/Quarterdeck.app/Contents/MacOS/Quarterdeck",
			"/bundle/Quarterdeck.app/Contents/Frameworks/Quarterdeck Helper (Plugin).app/Contents/MacOS/Quarterdeck Helper (Plugin)",
		]) {
			expect(signingOptionsForFile(path)).toEqual({
				hardenedRuntime: true,
				entitlements: join(desktopRoot, "assets/electron-entitlements.plist"),
			});
		}
		expect(signingOptionsForFile("/bundle/Quarterdeck.app/Contents/Resources/runtime/bin/node").entitlements).toBe(
			join(desktopRoot, "assets/runtime-entitlements.plist"),
		);
		for (const path of [
			"/bundle/Quarterdeck.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
			"/bundle/Quarterdeck.app/Contents/Resources/runtime/node_modules/node-pty/build/Release/pty.node",
			"/bundle/Quarterdeck.app/Contents/Resources/runtime/node_modules/node-pty/build/Release/spawn-helper",
		]) {
			expect(signingOptionsForFile(path)).toEqual({
				hardenedRuntime: true,
				entitlements: join(desktopRoot, "assets/library-entitlements.plist"),
			});
		}
	});
	it("rejects inherited device grants and executable/library validation exceptions", () => {
		const app = "/bundle/Quarterdeck.app";
		expect(() => verifyEntitlementDictionary(app, { [allowJit]: true })).not.toThrow();
		for (const key of [
			"com.apple.security.device.camera",
			"com.apple.security.device.audio-input",
			"com.apple.security.device.bluetooth",
			"com.apple.security.device.usb",
			"com.apple.security.device.print",
			"com.apple.security.personal-information.location",
			"com.apple.security.personal-information.photos-library",
			"com.apple.security.cs.allow-unsigned-executable-memory",
			"com.apple.security.cs.disable-library-validation",
			"com.apple.security.get-task-allow",
		]) {
			expect(() => verifyEntitlementDictionary(app, { [allowJit]: true, [key]: true })).toThrow(
				"minimal electron policy",
			);
		}
		for (const dictionary of [null, [], {}, { [allowJit]: false }, { [allowJit]: "true" }]) {
			expect(() => verifyEntitlementDictionary(app, dictionary)).toThrow();
		}
		expect(() => verifyEntitlementDictionary("/bundle/pty.node", {})).not.toThrow();
		expect(() => verifyEntitlementDictionary("/bundle/pty.node", { [allowJit]: true })).toThrow(
			"minimal library policy",
		);
	});
	it("requires the actual Developer ID team and hardened signature", () => {
		expect(() => verifyDeveloperIdIdentity(signature, "AB12345678")).not.toThrow();
		for (const identity of [
			signature.replace("TeamIdentifier=AB12345678", "TeamIdentifier=OTHERTEAM1"),
			signature.replace("Developer ID Application:", "Ad Hoc:"),
			signature.replace("flags=0x10000(runtime)", "flags=0x0(none)"),
		]) {
			expect(() => verifyDeveloperIdIdentity(identity, "AB12345678")).toThrow();
		}
	});
	it("audits real nested Mach-O files and excludes aliases and nonexecutable resources", async () => {
		const f = await fixture();
		try {
			const signer = syntheticSigner();
			expect((await verifySignedAppEntitlements(f.app, "AB12345678", signer.runCommand)).sort()).toEqual(
				f.files.sort(),
			);
			expect(signer.visited.filter(({ args }) => args.includes("--verify"))).toHaveLength(f.files.length);
			expect(signer.visited.filter(({ args }) => args.includes("--entitlements"))).toHaveLength(f.files.length);
		} finally {
			await rm(f.root, { recursive: true, force: true });
		}
	});
	it("fails the signed-artifact path on unexpected grants or identity", async () => {
		const f = await fixture();
		try {
			await expect(
				verifySignedAppEntitlements(
					f.app,
					"AB12345678",
					syntheticSigner({ "com.apple.security.device.camera": true }).runCommand,
				),
			).rejects.toThrow("minimal");
			await expect(
				verifySignedAppEntitlements(
					f.app,
					"AB12345678",
					syntheticSigner({}, signature.replaceAll("AB12345678", "OTHERTEAM1")).runCommand,
				),
			).rejects.toThrow("expected Developer ID team");
		} finally {
			await rm(f.root, { recursive: true, force: true });
		}
	});
});
