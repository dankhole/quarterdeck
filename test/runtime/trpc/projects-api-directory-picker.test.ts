import { describe, expect, it } from "vitest";

import type { RuntimeProjectDirectoryPickerResponse } from "../../../src/core";
import { type CreateProjectsApiDependencies, createProjectsApi } from "../../../src/trpc/projects-api";

function createApi(pickDirectory: () => Promise<RuntimeProjectDirectoryPickerResponse>) {
	return createProjectsApi({
		hostIntegrations: { pickDirectory },
	} as CreateProjectsApiDependencies);
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
