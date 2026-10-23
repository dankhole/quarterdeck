import type { RuntimeListFilesResponse } from "@/runtime/types";

export function fileTreePage(overrides: Partial<RuntimeListFilesResponse> = {}): RuntimeListFilesResponse {
	return {
		directory: "",
		files: [],
		directories: [],
		snapshotId: "snapshot-1",
		nextCursor: null,
		hiddenCount: 0,
		mutable: true,
		...overrides,
	};
}
