import { describe, expect, it } from "vitest";
import type { FileEditorDraft } from "./file-editor-cache";
import {
	decodeFileEditorRecovery,
	encodeFileEditorRecovery,
	FILE_EDITOR_RECOVERY_LIMITS,
	sameFileEditorRecoveryScope,
} from "./file-editor-recovery";
import { createFileEditorTab } from "./file-editor-workspace";

const now = 1_000_000_000_000;
function draft(overrides: Partial<FileEditorDraft> = {}): FileEditorDraft {
	return {
		id: "draft",
		scopeKey: "p:t",
		generation: 1,
		scope: { projectId: "p", taskId: "t", taskCreatedAt: 1, rootPath: "/repo/worktree" },
		detached: false,
		tab: {
			...createFileEditorTab("src/a.ts", {
				content: "saved",
				contentHash: "hash",
				language: "typescript",
				binary: false,
				truncated: false,
				size: 5,
			}),
			value: "unsaved\nλ😀",
		},
		...overrides,
	};
}
function encoded(drafts = [draft()]) {
	const result = encodeFileEditorRecovery(drafts, [], now);
	if (!result.ok) throw new Error("Test draft refused");
	return result;
}

describe("desktop file draft recovery serialization", () => {
	it("round trips Unicode, original revision and complete project/worktree identity, excluding transient errors", () => {
		const source = draft();
		const snapshot = encoded([{ ...source, tab: { ...source.tab, error: "private diagnostic", isSaving: true } }]);
		const decoded = decodeFileEditorRecovery(snapshot.raw, now);
		expect(decoded).toMatchObject({
			expired: 0,
			problem: null,
			drafts: [{ scope: source.scope, tab: { value: source.tab.value, savedValue: "saved", contentHash: "hash" } }],
		});
		expect(snapshot.raw).not.toContain("private diagnostic");
		expect(snapshot.raw).not.toContain("isSaving");
	});
	it.each([
		"{",
		JSON.stringify({ schemaVersion: 2, drafts: [] }),
		JSON.stringify({ schemaVersion: 1, drafts: [{ scope: {} }] }),
	])("refuses corrupt or incompatible snapshots", (raw) => {
		expect(decodeFileEditorRecovery(raw, now).problem).toBe("invalid");
	});
	it("requires exact task creation and repository identity, never a task ID alone", () => {
		const scope = draft().scope;
		expect(sameFileEditorRecoveryScope(scope, { ...scope })).toBe(true);
		for (const replacement of [
			{ ...scope, taskCreatedAt: 2 },
			{ ...scope, rootPath: "/other" },
			{ ...scope, projectId: "other" },
			{ ...scope, taskCreatedAt: undefined },
		])
			expect(sameFileEditorRecoveryScope(scope, replacement)).toBe(false);
	});
	it.each(["../a.ts", "/a.ts", "a/../b", "a\\b", "a\0b"])("refuses unsafe relative path %s", (path) => {
		const source = draft();
		expect(encodeFileEditorRecovery([{ ...source, tab: { ...source.tab, path } }], [], now)).toMatchObject({
			ok: false,
			problem: "identity",
		});
	});
	it("expires unchanged copies without renewing them when another snapshot is encoded", () => {
		const snapshot = encoded();
		const later = now + FILE_EDITOR_RECOVERY_LIMITS.maxAgeMs + 1;
		expect(decodeFileEditorRecovery(snapshot.raw, later)).toMatchObject({ drafts: [], expired: 1, problem: null });
		const current = encodeFileEditorRecovery([draft()], snapshot.drafts, later);
		if (!current.ok) throw new Error("Live draft unexpectedly refused");
		expect(decodeFileEditorRecovery(current.raw, later)).toMatchObject({ drafts: [], expired: 1 });
		const changed = encodeFileEditorRecovery(
			[{ ...draft(), tab: { ...draft().tab, value: "new current edit" } }],
			snapshot.drafts,
			later,
		);
		if (!changed.ok) throw new Error("Changed draft unexpectedly refused");
		expect(decodeFileEditorRecovery(changed.raw, later).drafts).toHaveLength(1);
		const unchangedRecovery = encodeFileEditorRecovery(
			[{ ...draft(), recovered: true, recoveryId: snapshot.drafts[0]!.id }],
			snapshot.drafts,
			later,
		);
		if (!unchangedRecovery.ok) throw new Error("Recovery unexpectedly refused");
		expect(decodeFileEditorRecovery(unchangedRecovery.raw, later).expired).toBe(1);
	});
	it("preserves each unchanged draft's expiry when another file changes", () => {
		const first = draft();
		const second = { ...draft(), tab: { ...draft().tab, path: "src/b.ts" } };
		const initial = encoded([first, second]);
		const next = encodeFileEditorRecovery(
			[first, { ...second, tab: { ...second.tab, value: "new edit" } }],
			initial.drafts,
			now + 1_000,
		);
		if (!next.ok) throw new Error("Changed snapshot unexpectedly refused");
		expect(next.drafts.map(({ updatedAt }) => updatedAt)).toEqual([now, now + 1_000]);
	});
	it("rejects count, per-draft and total quotas without dropping any current input draft", () => {
		const source = draft();
		const inputs = [
			Array.from({ length: 33 }, (_, i) => ({ ...source, generation: i })),
			[{ ...source, tab: { ...source.tab, value: "x".repeat(FILE_EDITOR_RECOVERY_LIMITS.maxDraftBytes) } }],
			Array.from({ length: 8 }, (_, i) => ({
				...source,
				generation: i,
				tab: { ...source.tab, value: "x".repeat(150_000) },
			})),
		];
		for (const drafts of inputs)
			expect(encodeFileEditorRecovery(drafts, [], now)).toMatchObject({ ok: false, problem: "limit" });
		expect(source.tab.value).toBe("unsaved\nλ😀");
	});
	it("does not persist clean tabs, task prompts or arbitrary snapshot fields", () => {
		const source = draft();
		expect(encoded([{ ...source, tab: { ...source.tab, value: source.tab.savedValue } }]).drafts).toEqual([]);
		const snapshot = JSON.parse(encoded().raw) as Record<string, unknown>;
		expect(Object.keys(snapshot)).toEqual(["schemaVersion", "drafts"]);
		expect(decodeFileEditorRecovery(JSON.stringify({ ...snapshot, prompt: "private" }), now).problem).toBe("invalid");
	});
});
