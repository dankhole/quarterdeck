import { useEffect } from "react";
import type { RuntimeProjectMetadata } from "@/runtime/types";
import { replaceProjectMetadata } from "@/stores/project-metadata-store";

interface UseBoardMetadataSyncInput {
	projectId: string | null;
	projectMetadata: RuntimeProjectMetadata | null;
}

/** Mirrors runtime metadata into the external read model used by the UI. */
export function useBoardMetadataSync({ projectId, projectMetadata }: UseBoardMetadataSyncInput): void {
	useEffect(() => {
		replaceProjectMetadata(projectId, projectMetadata);
	}, [projectId, projectMetadata]);
}
