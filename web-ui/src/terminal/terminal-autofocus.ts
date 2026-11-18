/** One cancellable focus request for each hidden-to-visible terminal activation. */
export class TerminalAutofocus {
	private visible = false;
	private pending = false;
	private readonly document: Document;
	private readonly window: Window | null;

	constructor(
		private readonly host: HTMLElement,
		private readonly focus: () => void,
	) {
		this.document = host.ownerDocument;
		this.window = this.document.defaultView;
	}

	setVisible(visible: boolean, autoFocus: boolean): void {
		if (!visible) {
			this.visible = false;
			this.cancel();
			return;
		}
		if (this.visible) return;
		this.visible = true;
		if (!autoFocus) return;
		this.pending = true;
		this.document.addEventListener("focusin", this.onInteraction, true);
		this.document.addEventListener("pointerdown", this.onInteraction, true);
		this.document.addEventListener("keydown", this.onInteraction, true);
		this.window?.addEventListener("blur", this.onWindowBlur);
	}

	private readonly onInteraction = (event: Event): void => {
		if (!event.composedPath().includes(this.host)) this.cancel();
	};

	private readonly onWindowBlur = (): void => {
		this.cancel();
	};

	cancel(): void {
		this.pending = false;
		this.document.removeEventListener("focusin", this.onInteraction, true);
		this.document.removeEventListener("pointerdown", this.onInteraction, true);
		this.document.removeEventListener("keydown", this.onInteraction, true);
		this.window?.removeEventListener("blur", this.onWindowBlur);
	}

	focusAfterReveal(): void {
		if (!this.pending) return;
		this.cancel();
		this.focus();
	}
}
