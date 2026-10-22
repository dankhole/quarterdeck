import { isRuntimeTaskImageRef } from "@runtime-contract";
import { useContext, useEffect, useState } from "react";
import { ProjectSyncContext } from "@/providers/project-provider";
import { fetchTaskImageData } from "@/runtime/task-image-query";
import type { TaskImage } from "@/types";

export type TaskImageSourceStatus = "ready" | "loading" | "missing";

export interface TaskImageSource {
	src: string | null;
	status: TaskImageSourceStatus;
}

interface LoadedTaskImage {
	key: string;
	data: string | null;
}

/**
 * Preview source for one attachment. Inline uploads render immediately; stored
 * references load lazily from the board's own project, and a late result for
 * another project or hash is ignored.
 */
export function useTaskImageSource(image: TaskImage): TaskImageSource {
	const projectId = useContext(ProjectSyncContext)?.boardProjectId ?? null;
	const sha256 = isRuntimeTaskImageRef(image) ? image.sha256 : null;
	const key = projectId && sha256 ? `${projectId}\u0000${sha256}` : null;
	const [loaded, setLoaded] = useState<LoadedTaskImage | null>(null);

	useEffect(() => {
		if (!projectId || !sha256 || !key) return;
		let current = true;
		void fetchTaskImageData(projectId, sha256).then(
			(data) => {
				if (current) setLoaded({ key, data });
			},
			() => {
				if (current) setLoaded({ key, data: null });
			},
		);
		return () => {
			current = false;
		};
	}, [key, projectId, sha256]);

	if (!isRuntimeTaskImageRef(image)) {
		return { src: `data:${image.mimeType};base64,${image.data}`, status: "ready" };
	}
	if (!key) return { src: null, status: "missing" };
	if (loaded?.key !== key) return { src: null, status: "loading" };
	return loaded.data === null
		? { src: null, status: "missing" }
		: { src: `data:${image.mimeType};base64,${loaded.data}`, status: "ready" };
}
