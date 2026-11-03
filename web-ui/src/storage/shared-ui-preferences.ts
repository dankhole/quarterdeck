import {
	RUNTIME_UI_PREFERENCE_KEYS,
	type RuntimeGitViewPreference,
	type RuntimeUiPreferenceKey,
	type RuntimeUiPreferences,
	type RuntimeUiPreferencesPatch,
	runtimeUiPreferencesPatchSchema,
	runtimeUiPreferencesSchema,
	runtimeUiPreferenceValuesSchema,
} from "@runtime-contract";

export interface UiPreferencesTransport {
	read: () => Promise<RuntimeUiPreferences>;
	patch: (patch: RuntimeUiPreferencesPatch) => Promise<RuntimeUiPreferences>;
}

export function isSharedUiPreferenceKey(key: string): key is RuntimeUiPreferenceKey {
	return Object.hasOwn(runtimeUiPreferenceValuesSchema.shape, key);
}

function parseLegacyValue(key: RuntimeUiPreferenceKey, raw: string): unknown {
	const schema = runtimeUiPreferenceValuesSchema.shape[key];
	const stringResult = schema.safeParse(raw);
	if (stringResult.success) return stringResult.data;
	try {
		const result = schema.safeParse(JSON.parse(raw));
		return result.success ? result.data : undefined;
	} catch {
		return undefined;
	}
}

/** Only explicitly present, validated allowlisted legacy values may seed disk. */
export function collectLegacyUiPreferences(storage: Storage | null): RuntimeUiPreferencesPatch {
	const values: RuntimeUiPreferencesPatch["values"] = {};
	const collapsedProjectGroups: NonNullable<RuntimeUiPreferencesPatch["collapsedProjectGroups"]> = {};
	if (storage) {
		for (const key of RUNTIME_UI_PREFERENCE_KEYS) {
			try {
				const raw = storage.getItem(key);
				if (raw === null) continue;
				const value = parseLegacyValue(key, raw);
				if (value !== undefined) Object.assign(values, { [key]: value });
			} catch {
				/* Browser storage is optional. */
			}
		}
		try {
			if (!Object.hasOwn(values, "quarterdeck.detail-last-sidebar-tab")) {
				const legacy = storage.getItem("quarterdeck.detail-last-task-tab");
				if (legacy === "changes" || legacy === "task_column")
					values["quarterdeck.detail-last-sidebar-tab"] = "task_column";
			}
		} catch {
			/* Browser storage is optional. */
		}
		try {
			for (let index = 0; index < storage.length; index++) {
				const key = storage.key(index);
				if (!key?.startsWith("quarterdeck.project-groups-collapsed.")) continue;
				const scope = key.slice("quarterdeck.project-groups-collapsed.".length);
				try {
					const ids: unknown = JSON.parse(storage.getItem(key) ?? "null");
					const result = runtimeUiPreferencesPatchSchema.safeParse({
						mode: "seed",
						values,
						collapsedProjectGroups: { ...collapsedProjectGroups, [scope]: ids },
					});
					if (result.success) Object.assign(collapsedProjectGroups, result.data.collapsedProjectGroups);
				} catch {
					/* Ignore malformed legacy presentation state. */
				}
			}
		} catch {
			/* Browser storage is optional. */
		}
	}
	return { mode: "seed", values, collapsedProjectGroups };
}

/** Runtime snapshots own saved values; pending patches own only their changed keys. */
export class SharedUiPreferencesStore {
	private snapshot: RuntimeUiPreferences | null = null;
	private transport: UiPreferencesTransport | null = null;
	private tail: Promise<void> = Promise.resolve();
	private sequence = 0;
	private readonly pending = new Map<string, { sequence: number; value: unknown }>();
	private readonly listeners = new Set<() => void>();
	private onSaveError: (error: unknown) => void = () => {};

	get active(): boolean {
		return this.snapshot !== null;
	}
	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	private emit(): void {
		for (const listener of this.listeners) listener();
	}

	async initialize(
		transport: UiPreferencesTransport,
		legacy: RuntimeUiPreferencesPatch,
		onSaveError: (error: unknown) => void,
	): Promise<void> {
		this.transport = transport;
		this.onSaveError = onSaveError;
		let snapshot = runtimeUiPreferencesSchema.parse(await transport.read());
		if (
			Object.keys(legacy.values).length ||
			Object.keys(legacy.collapsedProjectGroups ?? {}).length ||
			Object.keys(legacy.gitViews ?? {}).length
		) {
			// Seed intent is merged under the runtime lock, so another client's saved
			// values win even if they arrived after the preceding read.
			snapshot = runtimeUiPreferencesSchema.parse(await transport.patch(legacy));
		}
		this.apply(snapshot);
	}

	/** Isolated viewers read runtime authority without legacy migration or a write transport. */
	async initializeReadOnly(transport: Pick<UiPreferencesTransport, "read">): Promise<void> {
		this.transport = null;
		this.pending.clear();
		this.onSaveError = () => {};
		this.apply(await transport.read());
	}

	apply(snapshot: RuntimeUiPreferences): void {
		const parsed = runtimeUiPreferencesSchema.parse(snapshot);
		if (this.snapshot && parsed.revision < this.snapshot.revision) return;
		this.snapshot = parsed;
		this.emit();
	}

	read(key: RuntimeUiPreferenceKey): string | null {
		const pending = this.pending.get(key);
		const value = pending ? pending.value : this.snapshot?.values[key];
		return value === null || value === undefined ? null : String(value);
	}

	readCollapsedGroups(scope: string): string[] {
		const value = this.pending.get(`groups:${scope}`)?.value ?? this.snapshot?.collapsedProjectGroups[scope];
		return Array.isArray(value) ? (value as string[]) : [];
	}

	readGitView(scope: string): RuntimeGitViewPreference {
		const views = this.snapshot?.gitViews;
		const preference = { ...(views && Object.hasOwn(views, scope) ? views[scope] : {}) };
		const activeTab = this.pending.get(`git:${scope}:activeTab`);
		const collapsedDirectories = this.pending.get(`git:${scope}:collapsedDirectories`);
		if (activeTab) preference.activeTab = activeTab.value as RuntimeGitViewPreference["activeTab"];
		if (collapsedDirectories) preference.collapsedDirectories = collapsedDirectories.value as string[];
		return preference;
	}

	writeGitView(scope: string, preference: RuntimeGitViewPreference): void {
		const result = runtimeUiPreferencesPatchSchema.safeParse({
			mode: "patch",
			values: {},
			gitViews: { [scope]: preference },
		});
		if (!result.success) {
			this.onSaveError(new Error("The Git view preference is invalid."));
			return;
		}
		const entries: Array<[string, unknown]> = Object.entries(result.data.gitViews?.[scope] ?? {})
			.filter(([, value]) => value !== undefined)
			.map(([field, value]) => [`git:${scope}:${field}`, value]);
		if (entries.length) this.enqueue(result.data, entries);
	}

	write(key: RuntimeUiPreferenceKey, raw: string | null): void {
		const value = raw === null ? null : parseLegacyValue(key, raw);
		if (value === undefined) {
			this.onSaveError(new Error("The UI preference value is invalid."));
			return;
		}
		this.enqueue({ mode: "patch", values: { [key]: value } }, [[key, value]]);
	}

	writeCollapsedGroups(scope: string, ids: string[]): void {
		const result = runtimeUiPreferencesPatchSchema.safeParse({
			mode: "patch",
			values: {},
			collapsedProjectGroups: { [scope]: ids },
		});
		if (!result.success) return;
		this.enqueue(result.data, [[`groups:${scope}`, ids]]);
	}

	private enqueue(patch: RuntimeUiPreferencesPatch, entries: Array<[string, unknown]>): void {
		const transport = this.transport;
		if (!transport || !this.active) return;
		const sequence = ++this.sequence;
		for (const [key, value] of entries) this.pending.set(key, { sequence, value });
		this.emit();
		this.tail = this.tail.then(async () => {
			try {
				this.apply(await transport.patch(patch));
			} catch (error) {
				this.onSaveError(error);
			} finally {
				for (const [key] of entries) {
					if (this.pending.get(key)?.sequence === sequence) this.pending.delete(key);
				}
				this.emit();
			}
		});
	}

	async flush(): Promise<void> {
		await this.tail;
	}
}

export const sharedUiPreferences = new SharedUiPreferencesStore();
