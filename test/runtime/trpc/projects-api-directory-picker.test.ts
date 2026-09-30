import { describe, expect, it } from "vitest";

import type { RuntimeProjectDirectoryPickerResponse } from "../../../src/core";
import { createProjectsApi } from "../../../src/trpc/projects-api";

function createApi(pickDirectory: () => Promise<RuntimeProjectDirectoryPickerResponse>) {
	const unused = (): never => {
		throw new Error("Directory picker must not access a project.");
	};
	return createProjectsApi({
		hostIntegrations: { pickDirectory },
		runRegistrationMutation: async (operation) => await operation(),
		runProjectRemoval: async (_projectId, operation) => await operation(),
		projectLocations: {
			rename: unused,
			locate: unused,
			renameFolder: unused,
			checkAvailability: unused,
		},
		projects: {
			getActiveProjectId: unused,
			getActiveProjectPath: unused,
			getProjectPathById: unused,
			rememberProject: unused,
			setActiveProject: unused,
			clearActiveProject: unused,
		},
		boardCommands: { resolveMissingTaskBaseRefs: unused },
		terminals: { getTerminalManagerForProject: unused, ensureTerminalManagerForProject: unused },
		broadcaster: { broadcastRuntimeProjectsUpdated: unused, broadcastRuntimeProjectStateUpdated: unused },
		data: { buildProjectStateSnapshot: unused, buildProjectsPayload: unused, buildProjectSummary: unused },
		resolveProjectInputPath: unused,
		assertPathIsDirectory: unused,
		hasGitRepository: unused,
		disposeProject: unused,
		prepareProjectRemoval: unused,
		collectProjectWorktreeTaskIdsForRemoval: unused,
		warn: unused,
	});
}

describe("projects API directory picker", () => {
	it("returns typed cancellation", async () => {
		const response = await createApi(async () => ({
			ok: false,
			path: null,
			reason: "cancelled",
			error: "No directory was selected.",
		})).pickProjectDirectory(null);
		expect(response).toEqual({
			ok: false,
			path: null,
			reason: "cancelled",
			error: "No directory was selected.",
		});
	});

	it("returns typed native UI unavailability", async () => {
		const response = await createApi(async () => ({
			ok: false,
			path: null,
			reason: "native_ui_unavailable",
			error: "Native UI is unavailable.",
		})).pickProjectDirectory(null);

		expect(response).toMatchObject({
			ok: false,
			path: null,
			reason: "native_ui_unavailable",
		});
	});
});
