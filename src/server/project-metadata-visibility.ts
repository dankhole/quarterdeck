export const LEGACY_PROJECT_METADATA_CLIENT_ID = "legacy";

export interface ProjectMetadataVisibilityReport {
	isDocumentVisible: boolean;
	activeConnectionCount: number;
}

export type ProjectMetadataVisibilityReports = Map<string, ProjectMetadataVisibilityReport>;

export interface ProjectMetadataVisibilityChange {
	previouslyVisible: boolean;
	isVisible: boolean;
	didEffectiveVisibilityChange: boolean;
}

export function normalizeProjectMetadataClientId(clientId: string | null | undefined): string {
	const trimmed = clientId?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : LEGACY_PROJECT_METADATA_CLIENT_ID;
}

export function isProjectMetadataVisible(reports: ProjectMetadataVisibilityReports): boolean {
	for (const report of reports.values()) {
		if (report.activeConnectionCount > 0 && report.isDocumentVisible) {
			return true;
		}
	}
	return false;
}

export function getActiveProjectMetadataClientCount(reports: ProjectMetadataVisibilityReports): number {
	let count = 0;
	for (const report of reports.values()) {
		count += report.activeConnectionCount;
	}
	return count;
}

export function connectProjectMetadataClient(
	reports: ProjectMetadataVisibilityReports,
	clientId: string | null | undefined,
	isDocumentVisible = true,
): ProjectMetadataVisibilityChange {
	const previouslyVisible = isProjectMetadataVisible(reports);
	const normalizedClientId = normalizeProjectMetadataClientId(clientId);
	const existing = reports.get(normalizedClientId);
	if (existing) {
		reports.set(normalizedClientId, {
			...existing,
			isDocumentVisible,
			activeConnectionCount: existing.activeConnectionCount + 1,
		});
	} else {
		reports.set(normalizedClientId, {
			isDocumentVisible,
			activeConnectionCount: 1,
		});
	}
	return buildVisibilityChange(previouslyVisible, reports);
}

export function setProjectMetadataClientVisibility(
	reports: ProjectMetadataVisibilityReports,
	clientId: string | null | undefined,
	isDocumentVisible: boolean,
): ProjectMetadataVisibilityChange {
	const previouslyVisible = isProjectMetadataVisible(reports);
	const normalizedClientId = normalizeProjectMetadataClientId(clientId);
	const existing = reports.get(normalizedClientId);
	if (!existing) {
		return buildVisibilityChange(previouslyVisible, reports);
	}
	if (existing.isDocumentVisible === isDocumentVisible) {
		return buildVisibilityChange(previouslyVisible, reports);
	}
	reports.set(normalizedClientId, {
		...existing,
		isDocumentVisible,
	});
	return buildVisibilityChange(previouslyVisible, reports);
}

export function disconnectProjectMetadataClient(
	reports: ProjectMetadataVisibilityReports,
	clientId: string | null | undefined,
): ProjectMetadataVisibilityChange {
	const previouslyVisible = isProjectMetadataVisible(reports);
	const normalizedClientId = normalizeProjectMetadataClientId(clientId);
	const existing = reports.get(normalizedClientId);
	if (!existing) {
		return buildVisibilityChange(previouslyVisible, reports);
	}
	if (existing.activeConnectionCount <= 1) {
		reports.delete(normalizedClientId);
	} else {
		reports.set(normalizedClientId, {
			...existing,
			activeConnectionCount: existing.activeConnectionCount - 1,
		});
	}
	return buildVisibilityChange(previouslyVisible, reports);
}

function buildVisibilityChange(
	previouslyVisible: boolean,
	reports: ProjectMetadataVisibilityReports,
): ProjectMetadataVisibilityChange {
	const isVisible = isProjectMetadataVisible(reports);
	return {
		previouslyVisible,
		isVisible,
		didEffectiveVisibilityChange: previouslyVisible !== isVisible,
	};
}
