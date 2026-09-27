import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type RuntimeAgentId,
	runtimeTaskSessionInputRequestSchema,
	TaskResourceOperationCoordinator,
} from "../../../src/core";
import type { TerminalSessionManager } from "../../../src/terminal";
import { handleSendTaskSessionInput } from "../../../src/trpc/handlers/send-task-session-input";
import { createTestTaskSessionSummary } from "../../utilities/task-session-factory";

const scope = { projectId: "project", projectPath: "/repo" };
const image = {
	id: "image",
	mimeType: "image/png",
	data: Buffer.from("synthetic image").toString("base64"),
	name: "../../untrusted-name.sh",
};
const request = { taskId: "task", sessionInstanceId: "launch-1", images: [image], intent: "write" };
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function fixture() {
	const identity = { sessionInstanceId: "launch-1", pid: 123, agentId: "codex" as RuntimeAgentId | null };
	const writeInput = vi.fn<TerminalSessionManager["writeInput"]>(() =>
		createTestTaskSessionSummary({ taskId: "task" }),
	);
	const getTaskSessionProcessIdentity = vi.fn(() => identity);
	const manager = { writeInput, getTaskSessionProcessIdentity } as unknown as TerminalSessionManager;
	const assertNativeInputAllowed = vi.fn(async () => {});
	return {
		writeInput,
		identity,
		getTaskSessionProcessIdentity,
		deps: {
			getScopedTerminalManager: async () => manager,
			taskResourceOperations: new TaskResourceOperationCoordinator(),
			assertNativeInputAllowed,
		},
	};
}

describe("terminal image delivery", () => {
	it("writes private generated files and sends independent bracketed pastes without submitting", async () => {
		const { writeInput, deps } = fixture();
		const result = await handleSendTaskSessionInput(scope, { ...request, images: [image, image] }, deps);
		expect(result.ok).toBe(true);
		const call = writeInput.mock.calls[0];
		if (!call) throw new Error("Expected input delivery");
		const bytes = call[1].toString();
		const paths = bytes
			.split("\u001b[200~")
			.slice(1)
			.map((part) => part.slice(0, -6));
		expect(paths).toHaveLength(2);
		const firstPath = paths[0];
		if (!firstPath) throw new Error("Expected an image path");
		directories.push(dirname(firstPath));
		expect(bytes).not.toMatch(/[\r\n]/);
		expect(bytes).not.toContain("untrusted-name");
		expect(call[2]).toEqual({ explicitUserSubmission: false });
		for (const path of paths) {
			expect(await readFile(path, "utf8")).toBe("synthetic image");
			if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
		}
		expect(deps.assertNativeInputAllowed).toHaveBeenCalledTimes(2);
	});

	it("rejects stale launch identities before writing", async () => {
		const { writeInput, deps } = fixture();
		const result = await handleSendTaskSessionInput(scope, { ...request, sessionInstanceId: "old" }, deps);
		expect(result.ok).toBe(false);
		expect(writeInput).not.toHaveBeenCalled();
	});

	it("rejects image paste into a shell session", async () => {
		const { identity, writeInput, getTaskSessionProcessIdentity, deps } = fixture();
		getTaskSessionProcessIdentity.mockReturnValue({ ...identity, agentId: null });
		expect((await handleSendTaskSessionInput(scope, request, deps)).ok).toBe(false);
		expect(writeInput).not.toHaveBeenCalled();
	});

	it("rechecks identity after asynchronous file preparation", async () => {
		const { identity, writeInput, getTaskSessionProcessIdentity, deps } = fixture();
		getTaskSessionProcessIdentity.mockReturnValueOnce(identity).mockReturnValue({ ...identity, pid: 456 });
		expect((await handleSendTaskSessionInput(scope, request, deps)).ok).toBe(false);
		expect(writeInput).not.toHaveBeenCalled();
	});

	it("removes staged images when the PTY rejects delivery", async () => {
		const { writeInput, deps } = fixture();
		let imagePath = "";
		writeInput.mockImplementation((_taskId, data) => {
			imagePath = data.toString().slice(6, -6);
			throw new Error("PTY closed");
		});
		expect((await handleSendTaskSessionInput(scope, request, deps)).ok).toBe(false);
		expect(imagePath).toContain("quarterdeck-pasted-images-");
		await expect(stat(dirname(imagePath))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each([
		{ ...request, intent: "submit" },
		{ ...request, appendNewline: true },
		{ ...request, text: "must not silently discard the images" },
		{ ...request, images: [] },
		{ ...request, images: [{ ...image, mimeType: "text/html" }] },
		{ ...request, images: [{ ...image, data: "invalid base64" }] },
		{ ...request, images: Array.from({ length: 11 }, () => image) },
	])("rejects invalid image requests without entering input handling", (input) => {
		expect(runtimeTaskSessionInputRequestSchema.safeParse(input).success).toBe(false);
	});
});
