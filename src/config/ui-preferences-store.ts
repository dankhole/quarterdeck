import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	MAX_UI_PREFERENCES_BYTES,
	type RuntimeUiPreferences,
	type RuntimeUiPreferencesPatch,
	runtimeUiPreferencesPatchSchema,
	runtimeUiPreferencesSchema,
} from "../core/api/ui-preferences.js";
import { getRuntimeHomePath } from "../core/runtime-state-home.js";
import { isNodeError, lockedFileSystem } from "../fs/index.js";

export function getRuntimeUiPreferencesPath(): string {
	return join(getRuntimeHomePath(), "ui-preferences.json");
}

/** Disk is authoritative; every patch reads and merges under the same file lock. */
export class UiPreferencesStore {
	constructor(private readonly path = getRuntimeUiPreferencesPath()) {}

	async read(): Promise<RuntimeUiPreferences> {
		let raw: string;
		try {
			if ((await stat(this.path)).size > MAX_UI_PREFERENCES_BYTES)
				throw new Error("Shared UI preferences exceed the storage limit.");
			raw = await readFile(this.path, "utf8");
		} catch (error) {
			if (isNodeError(error, "ENOENT")) return { revision: 0, values: {}, collapsedProjectGroups: {} };
			throw error;
		}
		// Invalid persisted state must not be mistaken for a fresh profile.
		return runtimeUiPreferencesSchema.parse(JSON.parse(raw));
	}

	async patch(input: RuntimeUiPreferencesPatch): Promise<RuntimeUiPreferences> {
		const patch = runtimeUiPreferencesPatchSchema.parse(input);
		return await lockedFileSystem.withLock({ path: this.path }, async () => {
			const previous = await this.read();
			const values = { ...previous.values };
			const collapsedProjectGroups = { ...previous.collapsedProjectGroups };
			for (const [key, value] of Object.entries(patch.values)) {
				if (patch.mode === "seed" && Object.hasOwn(values, key)) continue;
				Object.assign(values, { [key]: value });
			}
			for (const [scope, ids] of Object.entries(patch.collapsedProjectGroups ?? {})) {
				if (patch.mode === "seed" && Object.hasOwn(collapsedProjectGroups, scope)) continue;
				collapsedProjectGroups[scope] = ids;
			}
			if (
				JSON.stringify(values) === JSON.stringify(previous.values) &&
				JSON.stringify(collapsedProjectGroups) === JSON.stringify(previous.collapsedProjectGroups)
			)
				return previous;
			const next = runtimeUiPreferencesSchema.parse({
				revision: previous.revision + 1,
				values,
				collapsedProjectGroups,
			});
			await lockedFileSystem.writeTextFileAtomic(this.path, JSON.stringify(next), { lock: null });
			return next;
		});
	}
}
