import { basename } from "node:path";

import { lockedFileSystem } from "../../../src/fs/locked-file-system";
import { ProjectBoardCommandService } from "../../../src/state/project-board-command-service";
import { loadProjectContext } from "../../../src/state/project-state";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

const [projectPath, crashAfter] = process.argv.slice(2);
if (!projectPath || !crashAfter) throw new Error("Expected project path and crash boundary");
const context = await loadProjectContext(projectPath);
const write = lockedFileSystem.writeJsonFileAtomic.bind(lockedFileSystem);
lockedFileSystem.writeJsonFileAtomic = async (path, payload, options) => {
	await write(path, payload, options);
	// Exit without finally blocks or lock release, exactly as a killed writer does.
	if (basename(path) === crashAfter) process.kill(process.pid, "SIGKILL");
};
const service = new ProjectBoardCommandService({
	getAuthoritativeSessions: () => ({
		"task-a": createTestTaskSessionSummary({ taskId: "task-a", state: "idle", updatedAt: 200 }),
	}),
});
await service.execute(
	{ projectId: context.projectId, projectPath },
	{
		commandId: "start:move",
		expectedRevision: 1,
		command: {
			kind: "move_task",
			taskId: "task-a",
			sourceColumnId: "review",
			targetColumnId: "in_progress",
			targetIndex: 0,
			updatedAt: 200,
		},
	},
);
throw new Error("Crash boundary was not reached");
