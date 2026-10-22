import { describe, expect, it, vi } from "vitest";

import { ProjectLocationService } from "../../../src/server/project-location-service";

/**
 * `checkAvailability` ("Check again") must distinguish "the probe itself
 * could not complete just now" from a confirmed answer. The shared relocation
 * fixture used elsewhere only registers folderOnly projects, which never
 * reach the Git probe, so it can never exercise the indeterminate path. These
 * tests exercise `ProjectLocationService.checkAvailability` directly against
 * a faked registry instead.
 */
function createService(
	checkProjectAvailabilityFreshness: () => Promise<{
		availability: { status: "available" } | { status: "unavailable"; reason: string };
		indeterminate: boolean;
	}>,
) {
	return new ProjectLocationService({
		runRegistrationMutation: async <T>(operation: () => Promise<T>) => await operation(),
		operations: {
			runProjectExclusive: async <T>(_projectId: string, operation: () => Promise<T>) => await operation(),
		},
		registry: {
			checkProjectAvailabilityFreshness,
			buildProjectSummary: async () => {
				throw new Error("not expected: checkAvailability must short-circuit before building a summary");
			},
			buildProjectStateSnapshot: async () => {
				throw new Error("not expected: checkAvailability must short-circuit before building a state snapshot");
			},
			rebindProjectLocation: async () => {
				throw new Error("not expected: checkAvailability must never relocate");
			},
		},
		boardCommands: { relocateProjectPaths: vi.fn() },
		assertRuntimeExclusive: async () => {},
		stopProject: async () => {},
		suspendProject: async () => {},
		refreshProject: async () => {},
		publishProjects: vi.fn(async () => {}),
		warn: () => {},
	} as unknown as ConstructorParameters<typeof ProjectLocationService>[0]);
}

describe("ProjectLocationService.checkAvailability indeterminate messaging", () => {
	it("reports a neutral retry message when the fresh probe is indeterminate, without claiming a timeout", async () => {
		const service = createService(async () => ({
			availability: { status: "available" },
			indeterminate: true,
		}));

		const result = await service.checkAvailability({ projectId: "synthetic-project" });

		expect(result).toEqual({
			ok: false,
			project: null,
			error: "Folder check could not complete; the system may be busy. Try again.",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).not.toMatch(/timed out/i);
		}
	});

	it("does not throw when the fresh probe is definitive, even if the project cannot be loaded afterward", async () => {
		// Confirms the indeterminate check itself is the only thing that throws;
		// a definitive result falls through to the normal `result()` flow (which
		// fails here only because this fixture has no real project registered).
		const service = createService(async () => ({
			availability: { status: "unavailable", reason: "not_git_repository" },
			indeterminate: false,
		}));

		const result = await service.checkAvailability({ projectId: "synthetic-project" });

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).not.toMatch(/busy|timed out/i);
		}
	});
});
