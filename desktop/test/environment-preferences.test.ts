import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyDesktopExecutableDirectories,
	DesktopEnvironmentPreferencesError,
	readDesktopEnvironmentPreferences,
	validateDesktopEnvironmentPreferences,
	writeDesktopEnvironmentPreferences,
} from "../src/environment-preferences.js";

const roots: string[] = [];
async function root(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "quarterdeck-environment-prefs-"));
	roots.push(directory);
	return directory;
}
afterEach(async () => {
	await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const prefs = (directories: string[]) => ({ version: 1 as const, extraExecutableDirectories: directories });

describe("desktop executable folder preferences", () => {
	it("defaults without creating storage, then privately persists only normalized folders", async () => {
		const directory = await root();
		await expect(readDesktopEnvironmentPreferences(directory)).resolves.toEqual(prefs([]));
		await expect(stat(join(directory, "environment-preferences"))).rejects.toMatchObject({ code: "ENOENT" });
		const folder = join(directory, "agent tools");
		await writeDesktopEnvironmentPreferences(directory, prefs([folder, join(folder, "..", "agent tools")]));
		await expect(readDesktopEnvironmentPreferences(directory)).resolves.toEqual(prefs([folder]));
		const file = join(directory, "environment-preferences", "folders.json");
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual(prefs([folder]));
		if (process.platform !== "win32") {
			expect((await stat(file)).mode & 0o777).toBe(0o600);
			expect((await stat(join(directory, "environment-preferences"))).mode & 0o777).toBe(0o700);
		}
	});

	it.each([
		null,
		{},
		{ version: 2, extraExecutableDirectories: [] },
		{ ...prefs([]), PATH: "secret" },
		prefs(["relative"]),
		prefs(["~/bin"]),
		prefs([`${resolve("/tools")}\nother`]),
		prefs([`${resolve("/tools")}\0other`]),
		prefs([`${resolve("/tools")}${delimiter}other`]),
		prefs(Array.from({ length: 17 }, (_, i) => resolve(`/tool-${i}`))),
		prefs([resolve(`/${"x".repeat(4_097)}`)]),
	])("rejects malformed or unbounded configuration %#", (value) => {
		expect(() => validateDesktopEnvironmentPreferences(value)).toThrow(DesktopEnvironmentPreferencesError);
	});

	it("bounds combined bytes and preserves existing preferences when a write is rejected", async () => {
		const directory = await root();
		const old = prefs([join(directory, "tools")]);
		await writeDesktopEnvironmentPreferences(directory, old);
		await expect(
			writeDesktopEnvironmentPreferences(
				directory,
				prefs(Array.from({ length: 16 }, (_, i) => resolve(`/${i}${"x".repeat(3_000)}`))),
			),
		).rejects.toBeInstanceOf(DesktopEnvironmentPreferencesError);
		await expect(readDesktopEnvironmentPreferences(directory)).resolves.toEqual(old);
	});

	it.each(["{broken-json", "x".repeat(32_769)])("fails safely on corrupt or oversized disk data", async (content) => {
		const directory = await root();
		await mkdir(join(directory, "environment-preferences"));
		await writeFile(join(directory, "environment-preferences", "folders.json"), content);
		await expect(readDesktopEnvironmentPreferences(directory)).rejects.toBeInstanceOf(
			DesktopEnvironmentPreferencesError,
		);
		expect(await readFile(join(directory, "environment-preferences", "folders.json"), "utf8")).toBe(content);
	});

	it.skipIf(process.platform === "win32")(
		"rejects symlinked storage rather than reading or writing another folder",
		async () => {
			const directory = await root();
			const target = await root();
			await symlink(target, join(directory, "environment-preferences"));
			await expect(readDesktopEnvironmentPreferences(directory)).rejects.toBeInstanceOf(
				DesktopEnvironmentPreferencesError,
			);
			await expect(writeDesktopEnvironmentPreferences(directory, prefs([]))).rejects.toBeInstanceOf(
				DesktopEnvironmentPreferencesError,
			);
			await expect(stat(join(target, "folders.json"))).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it("prepends configured directories after bundled Node, preserving unrelated in-memory values", () => {
		const bundled = resolve("/runtime/bin");
		const override = resolve("/custom/tools");
		const inherited = resolve("/inherited/tools");
		const environment = {
			PATH: [inherited, bundled, override, "relative"].join(delimiter),
			PROVIDER_OPTION: "in-memory-only",
		};
		expect(applyDesktopExecutableDirectories(environment, join(bundled, "node"), [override])).toEqual({
			PATH: [bundled, override, inherited].join(delimiter),
			PROVIDER_OPTION: "in-memory-only",
		});
		expect(environment.PATH).toContain("relative");
	});
});
