import {
	type DesktopQuitPreflightRequest,
	desktopPreflightReleaseSchema,
	desktopQuitPreflightRequestSchema,
} from "../../../../src/shared/desktop-bridge-contract";

const MAX_FREEZE_MS = 30_000;
const MUTATION_EVENTS = [
	"keydown",
	"beforeinput",
	"paste",
	"drop",
	"pointerdown",
	"click",
	"compositionstart",
] as const;

/** Navigation holds precede acknowledgement and survive until exact cancellation or document destruction. */
export class DesktopTransitionFreeze {
	private request: DesktopQuitPreflightRequest | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private readonly block = (event: Event): void => {
		event.preventDefault();
		event.stopImmediatePropagation();
	};
	constructor(private readonly onChange: (frozen: boolean) => void) {}
	get active(): boolean {
		return this.request !== null;
	}
	seal(request: DesktopQuitPreflightRequest): boolean {
		if (!desktopQuitPreflightRequestSchema.safeParse(request).success) return false;
		// A replacement document may be stalled indefinitely; another preflight cannot reopen this one.
		if (this.request?.freezeMode === "navigation") return false;
		const until = request.freezeUntil;
		if (until === undefined) return true;
		const remaining = until - Date.now();
		if (remaining <= 0 || remaining > MAX_FREEZE_MS) return false;
		this.release();
		this.request = request;
		for (const name of MUTATION_EVENTS) window.addEventListener(name, this.block, true);
		if (request.freezeMode !== "navigation") this.timer = setTimeout(() => this.release(), remaining);
		this.onChange(true);
		return true;
	}
	acceptRelease(payload: unknown): void {
		const release = desktopPreflightReleaseSchema.safeParse(payload);
		if (
			release.success &&
			release.data.requestId === this.request?.requestId &&
			release.data.runtimeGeneration === this.request.runtimeGeneration
		)
			this.release();
	}
	release(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.request = null;
		for (const name of MUTATION_EVENTS) window.removeEventListener(name, this.block, true);
		this.onChange(false);
	}
}
