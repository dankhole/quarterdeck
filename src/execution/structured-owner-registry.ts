import type { ClaudeStructuredOwnerRegistry } from "./claude-structured-owner";
import type { CodexStructuredOwnerRegistry } from "./codex-structured-owner";
import type {
	StartStructuredOwnerInput,
	StructuredOwner,
	StructuredOwnerEvents,
	StructuredOwnerRegistryContract,
} from "./structured-owner";

/** One runtime registry boundary with exactly one provider owner per task. */
export class StructuredOwnerRegistry implements StructuredOwnerRegistryContract {
	private readonly starting = new Set<string>();
	private launchesFenced = false;

	constructor(
		private readonly codex: CodexStructuredOwnerRegistry,
		private readonly claude: ClaudeStructuredOwnerRegistry,
	) {}

	setEvents(events: StructuredOwnerEvents): void {
		this.codex.setEvents(events);
		this.claude.setEvents(events);
	}

	get(projectId: string, taskId: string): StructuredOwner | null {
		return this.codex.get(projectId, taskId) ?? this.claude.get(projectId, taskId);
	}

	getOwnedProcessRootPids(): number[] {
		return [...this.codex.getOwnedProcessRootPids(), ...this.claude.getOwnedProcessRootPids()];
	}

	hasPendingLaunches(): boolean {
		return this.starting.size > 0;
	}

	fenceLaunches(): void {
		this.launchesFenced = true;
	}

	async start(input: StartStructuredOwnerInput): Promise<StructuredOwner> {
		if (this.launchesFenced) throw new Error("Runtime is shutting down.");
		const key = JSON.stringify([input.projectId, input.taskId]);
		if (this.starting.has(key) || this.get(input.projectId, input.taskId)) {
			throw new Error("A structured owner is already active for this task.");
		}
		this.starting.add(key);
		try {
			return input.provider === "claude" ? await this.claude.start(input) : await this.codex.start(input);
		} finally {
			this.starting.delete(key);
		}
	}

	async stop(
		projectId: string,
		taskId: string,
		ownerGeneration: number,
		ownerSessionInstanceId: string,
		timeoutMs = 3_000,
	): Promise<"exited" | "not_running" | "superseded" | "timed_out"> {
		if (this.codex.get(projectId, taskId)) {
			return await this.codex.stop(projectId, taskId, ownerGeneration, ownerSessionInstanceId, timeoutMs);
		}
		return await this.claude.stop(projectId, taskId, ownerGeneration, ownerSessionInstanceId, timeoutMs);
	}

	async stopAll(timeoutMs = 3_000): Promise<number> {
		return (await this.codex.stopAll(timeoutMs)) + (await this.claude.stopAll(timeoutMs));
	}
}
