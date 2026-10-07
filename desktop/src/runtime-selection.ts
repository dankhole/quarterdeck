import type { DesktopBootstrap, DesktopCapabilities } from "../../src/shared/desktop-bridge-contract.js";
import { runtimeOrigin } from "./security-policy.js";

/** Credentials and cancellation stay in main; a renderer receives only bootstrap. */
export interface SelectedRuntime {
	readonly generation: string;
	readonly origin: string;
	readonly clientToken: string;
	readonly signal: AbortSignal;
}

export class RuntimeSelection {
	private current: SelectedRuntime | null = null;
	private controller: AbortController | null = null;
	constructor(
		private readonly capabilities: DesktopCapabilities = {
			desktop: true,
			nativeDialogs: false,
			nativeNotifications: false,
		},
	) {}

	select(input: { generation: string; origin: string; clientToken: string }): SelectedRuntime {
		if (
			!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(input.generation) ||
			!/^[a-zA-Z0-9_-]{43,128}$/.test(input.clientToken)
		) {
			throw new Error("Invalid private runtime selection.");
		}
		const origin = runtimeOrigin(input.origin);
		this.clear();
		this.controller = new AbortController();
		this.current = Object.freeze({ ...input, origin, signal: this.controller.signal });
		return this.current;
	}

	get(): SelectedRuntime | null {
		return this.current;
	}

	clear(): void {
		this.controller?.abort();
		this.controller = null;
		this.current = null;
	}

	bootstrap(generation: string): DesktopBootstrap | null {
		const selected = this.current;
		if (!selected || selected.generation !== generation) return null;
		return {
			runtimeOrigin: selected.origin,
			runtimeGeneration: selected.generation,
			capabilities: { ...this.capabilities },
		};
	}
}
