import { describe, expect, it, vi } from "vitest";
import type { DesktopInstallation } from "../../src/desktop-install/index.js";
import { desktopUpdateGuidance, showDesktopUpdateGuidance } from "../src/update-guidance.js";

function owner(kind: "npm" | "link", prefix = "/synthetic/Node Install"): DesktopInstallation["owner"] {
	return {
		kind,
		prefix,
		packageSlot: `${prefix}/lib/node_modules/quarterdeck`,
		packageRoot: "/synthetic/Quarterdeck Checkout",
		identity: {
			schemaVersion: 1,
			version: "0.12.8",
			buildId: "build-local",
			sourceSha: "a".repeat(40),
			sourceDirty: false,
		},
	};
}

describe("npm-owned desktop updates", () => {
	it("pins checked manual updates to the public registry and rejects command text as a version", () => {
		expect(desktopUpdateGuidance(owner("npm"), "0.12.9").command).toBe(
			"QUARTERDECK_INSTALL_MODE=desktop npm install --global --prefix '/synthetic/Node Install' quarterdeck@0.12.9 --registry https://registry.npmjs.org --foreground-scripts",
		);
		expect(() => desktopUpdateGuidance(owner("npm"), "0.12.9; touch /tmp/invalid")).toThrow();
	});
	it("targets the owning prefix explicitly even when the current shell uses another Node", () => {
		const guidance = desktopUpdateGuidance(owner("npm"));
		expect(guidance.command).toBe(
			"QUARTERDECK_INSTALL_MODE=desktop npm install --global --prefix '/synthetic/Node Install' quarterdeck@latest",
		);
		expect(guidance.detail).toContain("/synthetic/Node Install");
		expect(guidance.detail).toContain("Quit Quarterdeck");
	});

	it("directs local installs to rebuild their recorded checkout", () => {
		const guidance = desktopUpdateGuidance(owner("link"));
		expect(guidance.command).toBe("cd '/synthetic/Quarterdeck Checkout' && npm run link");
		expect(guidance.detail).toContain("/synthetic/Quarterdeck Checkout");
	});

	it("quotes receipt paths as shell arguments", () => {
		const guidance = desktopUpdateGuidance(owner("npm", "/synthetic/O'Brien/$(touch bad)`cmd`"));
		expect(guidance.command).toBe(
			"QUARTERDECK_INSTALL_MODE=desktop npm install --global --prefix '/synthetic/O'\"'\"'Brien/$(touch bad)`cmd`' quarterdeck@latest",
		);
	});

	it("copies only after Copy Command is selected and performs no execution", async () => {
		const dialogs = { message: vi.fn(async () => 1) };
		const clipboard = { writeText: vi.fn() };
		await showDesktopUpdateGuidance(owner("npm"), dialogs, clipboard);
		expect(dialogs.message).toHaveBeenCalledWith(expect.objectContaining({ buttons: ["Done", "Copy Command"] }));
		expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith(desktopUpdateGuidance(owner("npm")).command);
		dialogs.message.mockResolvedValue(0);
		await showDesktopUpdateGuidance(owner("link"), dialogs, clipboard);
		expect(clipboard.writeText).toHaveBeenCalledTimes(1);
	});
});
