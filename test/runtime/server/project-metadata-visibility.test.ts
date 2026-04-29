import { describe, expect, it } from "vitest";

import {
	connectProjectMetadataClient,
	disconnectProjectMetadataClient,
	getActiveProjectMetadataClientCount,
	isProjectMetadataVisible,
	type ProjectMetadataVisibilityReports,
	setProjectMetadataClientVisibility,
} from "../../../src/server/project-metadata-visibility";

function createReports(): ProjectMetadataVisibilityReports {
	return new Map();
}

describe("project metadata visibility aggregation", () => {
	it("keeps a project visible when any connected client reports visible", () => {
		const reports = createReports();

		connectProjectMetadataClient(reports, "client-a");
		connectProjectMetadataClient(reports, "client-b");

		setProjectMetadataClientVisibility(reports, "client-a", true);
		setProjectMetadataClientVisibility(reports, "client-b", false);

		expect(isProjectMetadataVisible(reports)).toBe(true);

		setProjectMetadataClientVisibility(reports, "client-b", false);

		expect(isProjectMetadataVisible(reports)).toBe(true);
	});

	it("becomes hidden when the only visible client hides or disconnects", () => {
		const reports = createReports();

		connectProjectMetadataClient(reports, "client-a");
		connectProjectMetadataClient(reports, "client-b");
		setProjectMetadataClientVisibility(reports, "client-b", false);

		setProjectMetadataClientVisibility(reports, "client-a", false);
		expect(isProjectMetadataVisible(reports)).toBe(false);

		setProjectMetadataClientVisibility(reports, "client-a", true);
		expect(isProjectMetadataVisible(reports)).toBe(true);

		disconnectProjectMetadataClient(reports, "client-a");
		expect(isProjectMetadataVisible(reports)).toBe(false);
	});

	it("uses the current client visibility when a client connects or reconnects", () => {
		const reports = createReports();

		connectProjectMetadataClient(reports, "client-a", false);

		expect(isProjectMetadataVisible(reports)).toBe(false);

		connectProjectMetadataClient(reports, "client-a", true);

		expect(isProjectMetadataVisible(reports)).toBe(true);

		disconnectProjectMetadataClient(reports, "client-a");

		expect(isProjectMetadataVisible(reports)).toBe(true);
	});

	it("removes stale client visibility entries on disconnect", () => {
		const reports = createReports();

		connectProjectMetadataClient(reports, "client-a");
		connectProjectMetadataClient(reports, "client-b");
		setProjectMetadataClientVisibility(reports, "client-b", false);

		disconnectProjectMetadataClient(reports, "client-a");
		expect(getActiveProjectMetadataClientCount(reports)).toBe(1);
		expect(reports.has("client-a")).toBe(false);
		expect(isProjectMetadataVisible(reports)).toBe(false);

		setProjectMetadataClientVisibility(reports, "client-a", true);
		expect(isProjectMetadataVisible(reports)).toBe(false);

		disconnectProjectMetadataClient(reports, "client-b");
		expect(getActiveProjectMetadataClientCount(reports)).toBe(0);
		expect(reports.size).toBe(0);
	});

	it("keeps independent project visibility maps isolated", () => {
		const projectA = createReports();
		const projectB = createReports();

		connectProjectMetadataClient(projectA, "client-a");
		connectProjectMetadataClient(projectB, "client-b");

		setProjectMetadataClientVisibility(projectA, "client-a", false);

		expect(isProjectMetadataVisible(projectA)).toBe(false);
		expect(isProjectMetadataVisible(projectB)).toBe(true);
	});
});
