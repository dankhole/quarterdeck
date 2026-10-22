import { describe, expect, it, vi } from "vitest";

import { TaskResourceOperationCoordinator } from "../../../src/core";
import {
	createRelocationFailureResume,
	ProjectRelocationQuiesceGuard,
} from "../../../src/server/project-relocation-quiesce";

function createGuard() {
	const operations = new TaskResourceOperationCoordinator();
	const resumed: string[] = [];
	let exclusiveReleasedAtResume: boolean | null = null;
	const guard = new ProjectRelocationQuiesceGuard(
		(projectId, operation) => operations.runProjectExclusive(projectId, operation),
		async (projectId) => {
			// Resume must run after exclusion is released so it can take admission.
			exclusiveReleasedAtResume = await Promise.race([
				operations.runProject(projectId, async () => true),
				new Promise<boolean>((resolveWait) => setTimeout(() => resolveWait(false), 100)),
			]);
			resumed.push(projectId);
		},
		() => undefined,
	);
	return { guard, resumed, exclusiveReleasedAtResume: () => exclusiveReleasedAtResume };
}

describe("ProjectRelocationQuiesceGuard", () => {
	it("resumes a project whose relocation failed after quiesce, outside the exclusive section", async () => {
		const { guard, resumed, exclusiveReleasedAtResume } = createGuard();
		await expect(
			guard.runProjectExclusive("p", async () => {
				guard.markQuiesced("p");
				throw new Error("synthetic relocation failure");
			}),
		).rejects.toThrow("synthetic relocation failure");
		expect(resumed).toEqual(["p"]);
		expect(exclusiveReleasedAtResume()).toBe(true);

		// The failure is reported once; a later unrelated failure does not resume again.
		await expect(
			guard.runProjectExclusive("p", async () => {
				throw new Error("later failure");
			}),
		).rejects.toThrow("later failure");
		expect(resumed).toEqual(["p"]);
	});

	it("does not resume after a refreshed relocation or a failure before quiesce", async () => {
		const { guard, resumed } = createGuard();
		await guard.runProjectExclusive("p", async () => {
			guard.markQuiesced("p");
			guard.markRefreshed("p");
		});
		await expect(
			guard.runProjectExclusive("q", async () => {
				throw new Error("validation failure");
			}),
		).rejects.toThrow("validation failure");
		expect(resumed).toEqual([]);
	});

	it("keeps the original relocation error and reports a failed resume", async () => {
		const releaseFences = vi.fn();
		const refreshHub = vi.fn(async () => undefined);
		const resume = vi.fn(
			createRelocationFailureResume({
				releaseFences,
				loadScope: async () => {
					throw new Error("synthetic index read failure");
				},
				reattachManager: async () => undefined,
				refreshHub,
			}),
		);
		const onResumeFailed = vi.fn();
		const operations = new TaskResourceOperationCoordinator();
		const guard = new ProjectRelocationQuiesceGuard(
			(projectId, operation) => operations.runProjectExclusive(projectId, operation),
			resume,
			onResumeFailed,
		);
		await expect(
			guard.runProjectExclusive("p", async () => {
				guard.markQuiesced("p");
				throw new Error("original");
			}),
		).rejects.toThrow("original");
		expect(resume).toHaveBeenCalledOnce();
		// Fences are released before the failing scope read.
		expect(releaseFences).toHaveBeenCalledWith("p");
		expect(refreshHub).not.toHaveBeenCalled();
		expect(onResumeFailed).toHaveBeenCalledWith(
			"p",
			expect.objectContaining({ message: "synthetic index read failure" }),
		);
	});
});
