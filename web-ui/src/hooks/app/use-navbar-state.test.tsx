import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useNavbarState } from "@/hooks/app/use-navbar-state";
import type { RuntimeTaskRepositoryInfoResponse } from "@/runtime/types";
import type { BoardCard, BoardColumn, CardSelection } from "@/types";

function createSelection(useWorktree: boolean): CardSelection {
	const card: BoardCard = {
		id: "task-1",
		title: null,
		prompt: "Task",
		baseRef: "main",
		useWorktree,
		createdAt: 1,
		updatedAt: 1,
	};
	const column: BoardColumn = { id: "in_progress", title: "In Progress", cards: [card] };
	return { card, column, allColumns: [column] };
}

const missingRepositoryInfo: RuntimeTaskRepositoryInfoResponse = {
	taskId: "task-1",
	path: "/repo/.quarterdeck/worktrees/task-1",
	exists: false,
	baseRef: "main",
	branch: null,
	isDetached: false,
	headCommit: null,
};

const existingRepositoryInfo: RuntimeTaskRepositoryInfoResponse = {
	...missingRepositoryInfo,
	exists: true,
	branch: "task-branch",
};

describe("useNavbarState", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	function renderHook(input: Partial<Parameters<typeof useNavbarState>[0]>) {
		const holder: { result?: ReturnType<typeof useNavbarState> } = {};
		function Harness(): null {
			holder.result = useNavbarState({
				selectedCard: null,
				selectedTaskRepositoryInfo: null,
				selectedTaskWorktreeSnapshot: null,
				projectPath: "/repo",
				shouldUseNavigationPath: false,
				navigationProjectPath: null,
				runtimeProjectConfig: null,
				hasNoProjects: false,
				isProjectSwitching: false,
				isAwaitingProjectSnapshot: false,
				isProjectMetadataPending: false,
				...input,
			});
			return null;
		}
		act(() => {
			root.render(<Harness />);
		});
		if (!holder.result) {
			throw new Error("Expected hook result.");
		}
		return holder.result;
	}

	it("does not show a missing-worktree hint for shared-checkout tasks", () => {
		const result = renderHook({
			selectedCard: createSelection(false),
			selectedTaskRepositoryInfo: missingRepositoryInfo,
		});

		expect(result.navbarProjectPath).toBe("/repo");
		expect(result.navbarProjectHint).toBeUndefined();
	});

	it("uses the project root as the open path for shared-checkout tasks", () => {
		const result = renderHook({
			selectedCard: createSelection(false),
			selectedTaskRepositoryInfo: existingRepositoryInfo,
		});

		expect(result.activeProjectPath).toBe("/repo");
		expect(result.openProjectPath).toBe("/repo");
	});

	it("uses the assigned task worktree as the open path for isolated tasks", () => {
		const result = renderHook({
			selectedCard: createSelection(true),
			selectedTaskRepositoryInfo: existingRepositoryInfo,
		});

		expect(result.activeProjectPath).toBe("/repo/.quarterdeck/worktrees/task-1");
		expect(result.openProjectPath).toBe("/repo/.quarterdeck/worktrees/task-1");
	});

	it("does not fall back to the project root for isolated tasks without repository metadata", () => {
		const result = renderHook({
			selectedCard: createSelection(true),
			selectedTaskRepositoryInfo: null,
		});

		expect(result.activeProjectPath).toBe("/repo");
		expect(result.openProjectPath).toBeUndefined();
	});

	it("does not open missing isolated task worktrees", () => {
		const result = renderHook({
			selectedCard: createSelection(true),
			selectedTaskRepositoryInfo: missingRepositoryInfo,
		});

		expect(result.openProjectPath).toBeUndefined();
	});

	it("shows a missing-worktree hint for isolated tasks", () => {
		const result = renderHook({
			selectedCard: createSelection(true),
			selectedTaskRepositoryInfo: missingRepositoryInfo,
		});

		expect(result.navbarProjectHint).toBe("Task worktree not created yet");
	});
});
