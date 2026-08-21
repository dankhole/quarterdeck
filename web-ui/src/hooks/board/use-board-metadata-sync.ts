import { useEffect } from "react";
import type { RuntimeProjectMetadata } from "@/runtime/types";
import { replaceProjectMetadata } from "@/stores/project-metadata-store";

interface UseBoardMetadataSyncInput {
	projectMetadata: RuntimeProjectMetadata | null;
}

/** Mirrors runtime metadata into the external read model used by the UI. */
export function useBoardMetadataSync({ projectMetadata }: UseBoardMetadataSyncInput): void {
	useEffect(() => {
		replaceProjectMetadata(projectMetadata);
	}, [projectMetadata]);
}
