import { describe, expect, it, vi } from "vitest";
import { createTestTaskOutstandingInteraction, createTestTaskSessionSummary } from "@/test-utils/task-session-factory";
import { desktopCommandAvailabilitySchema } from "../../../../src/shared/desktop-bridge-contract";
import {
	deriveAppCommandAvailability,
	deriveDesktopFrontendStatus,
	dispatchDesktopAppCommand,
	resolveDesktopQuitPreflight,
} from "./desktop-app";

const allCommands = deriveAppCommandAvailability({
	runtimeConnected: true,
	projectActionsEnabled: true,
	selectedTask: true,
	onboarding: false,
});

describe("native application intent", () => {
	it("bounds availability to unique fixed command names and a current generation envelope", () => {
		const message = { runtimeGeneration: "current", runtimeConnected: true, commands: allCommands };
		expect(desktopCommandAvailabilitySchema.safeParse(message).success).toBe(true);
		for (const invalid of [
			{ ...message, commands: ["exec"] },
			{ ...message, commands: ["settings", "settings"] },
			{ ...message, commands: Array(12).fill("settings") },
			{ ...message, clientToken: "secret" },
			{ ...message, runtimeGeneration: "" },
		])
			expect(desktopCommandAvailabilitySchema.safeParse(invalid).success).toBe(false);
	});

	it("uses connection, onboarding and selected-task context rather than page readiness", () => {
		const base = { runtimeConnected: true, projectActionsEnabled: true, selectedTask: false, onboarding: false };
		expect(deriveAppCommandAvailability(base)).not.toContain("terminal");
		expect(deriveAppCommandAvailability({ ...base, selectedTask: true })).toContain("terminal");
		expect(deriveAppCommandAvailability({ ...base, runtimeConnected: false })).toEqual(["settings", "diagnostics"]);
		expect(deriveAppCommandAvailability({ ...base, onboarding: true })).toEqual(["settings", "diagnostics"]);
		expect(deriveAppCommandAvailability({ ...base, projectActionsEnabled: false })).toEqual([
			"settings",
			"diagnostics",
			"open-project",
		]);
		expect(deriveAppCommandAvailability({ ...base, frozen: true })).toEqual([]);
	});

	function handlers() {
		return {
			settings: vi.fn(),
			diagnostics: vi.fn(),
			newTask: vi.fn(),
			openProject: vi.fn(),
			navigate: vi.fn(),
			fileFinder: vi.fn(),
			textSearch: vi.fn(),
			toggleShell: vi.fn(),
		};
	}
	it("routes native commands to existing handlers and rejects stale or arbitrary commands", () => {
		const actions = handlers();
		for (const command of [
			"settings",
			"diagnostics",
			"new-task",
			"open-project",
			"files",
			"file-finder",
			"text-search",
			"toggle-shell",
		])
			expect(
				dispatchDesktopAppCommand({ runtimeGeneration: "current", command }, "current", actions, allCommands),
			).toBe(true);
		expect(actions.settings).toHaveBeenCalledTimes(1);
		expect(actions.diagnostics).toHaveBeenCalledTimes(1);
		expect(actions.newTask).toHaveBeenCalledTimes(1);
		expect(actions.openProject).toHaveBeenCalledTimes(1);
		expect(actions.navigate).toHaveBeenCalledWith("files");
		expect(actions.fileFinder).toHaveBeenCalledTimes(1);
		expect(actions.textSearch).toHaveBeenCalledTimes(1);
		expect(actions.toggleShell).toHaveBeenCalledTimes(1);
		expect(
			dispatchDesktopAppCommand({ runtimeGeneration: "old", command: "settings" }, "current", actions, allCommands),
		).toBe(false);
		expect(
			dispatchDesktopAppCommand(
				{ runtimeGeneration: "current", command: "exec", commandLine: "anything" },
				"current",
				actions,
				allCommands,
			),
		).toBe(false);
		expect(actions.settings).toHaveBeenCalledTimes(1);
	});
	it("guards project commands while preserving app settings and project-open intent", () => {
		const actions = handlers();
		for (const command of ["new-task", "terminal", "file-finder", "toggle-shell"])
			expect(
				dispatchDesktopAppCommand({ runtimeGeneration: "current", command }, "current", actions, [
					"settings",
					"diagnostics",
				]),
			).toBe(false);
		expect(
			dispatchDesktopAppCommand({ runtimeGeneration: "current", command: "settings" }, "current", actions, [
				"settings",
				"diagnostics",
			]),
		).toBe(true);
		expect(actions.newTask).not.toHaveBeenCalled();
	});
});

describe("desktop quit/update preflight", () => {
	it("projects current session metadata without inferring agent work from output", () => {
		const running = createTestTaskSessionSummary({ taskId: "running", state: "running", pid: 101 });
		const waiting = createTestTaskSessionSummary({
			taskId: "waiting",
			state: "awaiting_review",
			pid: 102,
			reviewReason: "attention",
			outstandingInteraction: createTestTaskOutstandingInteraction(),
		});
		const ended = createTestTaskSessionSummary({ taskId: "ended", pid: null, reviewReason: "exit" });
		expect(
			deriveDesktopFrontendStatus(
				{ first: { sessions: { running, waiting } }, second: { sessions: { ended } } },
				2,
				true,
			),
		).toMatchObject({
			dirtyEditorCount: 2,
			activeSessionCount: 2,
			needsInputSessionCount: 1,
			runtimeConnected: true,
		});
	});
	it.each(["quit", "update", "reload"] as const)(
		"blocks %s for dirty or disconnected editors and rejects a stale request",
		(reason) => {
			const request = { requestId: "request", runtimeGeneration: "current", reason };
			const status = {
				dirtyEditorCount: 1,
				activeSessionCount: 2,
				needsInputSessionCount: 1,
				runtimeConnected: true,
			};
			expect(resolveDesktopQuitPreflight(request, "current", status)?.decision).toBe("blocked");
			expect(
				resolveDesktopQuitPreflight(request, "current", { ...status, dirtyEditorCount: 0, runtimeConnected: false })
					?.decision,
			).toBe(reason === "update" ? "blocked" : "ready");
			expect(resolveDesktopQuitPreflight(request, "current", { ...status, dirtyEditorCount: 0 })?.decision).toBe(
				"ready",
			);
			expect(resolveDesktopQuitPreflight(request, "replacement", status)).toBeNull();
		},
	);
});
