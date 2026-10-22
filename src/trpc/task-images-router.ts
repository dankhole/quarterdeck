import { runtimeTaskImageReadRequestSchema, runtimeTaskImageReadResponseSchema } from "../core";
import { loadProjectBoardById } from "../state";
import { findInlineTaskImageBytes, readTaskImageBlob } from "../state/task-image-store";
import { savedProjectProcedure, t } from "./app-router-init";

/**
 * Lazy reads for stored task attachments. Boards carry only references, so
 * browsers fetch bytes per thumbnail. Scope comes from the authenticated
 * project header; the hash only selects a blob inside that project's store.
 */
export const taskImagesRouter = t.router({
	get: savedProjectProcedure
		.input(runtimeTaskImageReadRequestSchema)
		.output(runtimeTaskImageReadResponseSchema)
		.query(async ({ ctx, input }) => {
			const projectId = ctx.projectScope.projectId;
			// A legacy board publishes references before its first write stores the blobs.
			const bytes =
				(await readTaskImageBlob(projectId, input.sha256)) ??
				findInlineTaskImageBytes(await loadProjectBoardById(projectId), input.sha256);
			return bytes ? { sha256: input.sha256, data: bytes.toString("base64") } : null;
		}),
});
