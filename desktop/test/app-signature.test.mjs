import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { finalizeLocalAppSignature, verifyAppSignature } from "../scripts/app-signature.mjs";
import { run } from "../scripts/process.mjs";

describe("finished application signatures", () => {
	it("reseals local candidates while deriving their final bundle identity", () => {
		const command = vi.fn();
		finalizeLocalAppSignature("/candidate/Quarterdeck.app", false, command);
		expect(command).toHaveBeenCalledExactlyOnceWith(
			"/usr/bin/codesign",
			[
				"--sign",
				"-",
				"--force",
				"--deep",
				"--preserve-metadata=entitlements,flags,runtime",
				"/candidate/Quarterdeck.app",
			],
			{ stdio: "pipe" },
		);
	});

	it("never replaces a Developer ID distribution signature", () => {
		const command = vi.fn();
		finalizeLocalAppSignature("/candidate/Quarterdeck.app", true, command);
		expect(command).not.toHaveBeenCalled();
	});

	it("requires strict deep verification and propagates signing failures", () => {
		const command = vi.fn();
		verifyAppSignature("/candidate/Quarterdeck.app", command);
		expect(command).toHaveBeenCalledExactlyOnceWith(
			"/usr/bin/codesign",
			["--verify", "--deep", "--strict", "/candidate/Quarterdeck.app"],
			{ stdio: "pipe" },
		);
		const failed = () => {
			throw new Error("Invalid signature");
		};
		expect(() => finalizeLocalAppSignature("/candidate/Quarterdeck.app", false, failed)).toThrow("Invalid signature");
		expect(() => verifyAppSignature("/candidate/Quarterdeck.app", failed)).toThrow("Invalid signature");
	});

	it.skipIf(process.platform !== "darwin")(
		"repairs a mutated macOS bundle and rejects later plist changes",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "quarterdeck-signature-test-"));
			try {
				const app = join(root, "Quarterdeck.app");
				const contents = join(app, "Contents");
				await mkdir(join(contents, "MacOS"), { recursive: true });
				await copyFile("/usr/bin/true", join(contents, "MacOS", "Quarterdeck"));
				const plistPath = join(contents, "Info.plist");
				const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Quarterdeck</string>
<key>CFBundleIdentifier</key><string>com.github.Electron</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`;
				await writeFile(plistPath, plist);
				run("/usr/bin/codesign", ["--sign", "-", "--force", app], { stdio: "pipe" });
				await writeFile(plistPath, plist.replace("com.github.Electron", "io.github.dankhole.quarterdeck"));
				expect(() => verifyAppSignature(app)).toThrow();
				finalizeLocalAppSignature(app, false);
				expect(() => verifyAppSignature(app)).not.toThrow();
				const identity = run("/usr/bin/codesign", ["--display", "--verbose=4", app], {
					encoding: "utf8",
					stdio: "pipe",
				}).stderr;
				expect(identity).toContain("Identifier=io.github.dankhole.quarterdeck\n");
				const requirements = run("/usr/bin/codesign", ["--display", "--requirements", "-", app], {
					encoding: "utf8",
					stdio: "pipe",
				});
				expect(requirements.stdout + requirements.stderr).not.toContain("com.github.Electron");
				await writeFile(plistPath, `${await readFile(plistPath, "utf8")}\n`);
				expect(() => verifyAppSignature(app)).toThrow();
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);
});
