const PARKING_ROOT_ID = "kb-persistent-terminal-parking-root";

function getParkingRoot(): HTMLDivElement {
	const existingRoot = document.getElementById(PARKING_ROOT_ID);
	if (existingRoot instanceof HTMLDivElement) {
		return existingRoot;
	}
	const root = document.createElement("div");
	root.id = PARKING_ROOT_ID;
	root.setAttribute("aria-hidden", "true");
	Object.assign(root.style, {
		position: "fixed",
		left: "-10000px",
		top: "-10000px",
		width: "1px",
		height: "1px",
		overflow: "hidden",
		opacity: "0",
		pointerEvents: "none",
	});
	document.body.appendChild(root);
	return root;
}

function createHostElement(): HTMLDivElement {
	const hostElement = document.createElement("div");
	Object.assign(hostElement.style, {
		width: "100%",
		height: "100%",
		position: "absolute",
		inset: "0",
		visibility: "hidden",
	});
	return hostElement;
}

export class SlotDomHost {
	readonly hostElement: HTMLDivElement;
	private readonly parkingRoot: HTMLDivElement;
	private _stageContainer: HTMLDivElement | null = null;
	private _visibleContainer: HTMLDivElement | null = null;

	constructor() {
		this.parkingRoot = getParkingRoot();
		this.hostElement = createHostElement();
		this.parkingRoot.appendChild(this.hostElement);
	}

	get stageContainer(): HTMLDivElement | null {
		return this._stageContainer;
	}

	get visibleContainer(): HTMLDivElement | null {
		return this._visibleContainer;
	}

	get activeContainer(): HTMLDivElement | null {
		return this._visibleContainer ?? this._stageContainer;
	}

	attachToStageContainer(container: HTMLDivElement): { hadPreviousStage: boolean } {
		const hadPreviousStage = this._stageContainer !== null;
		this._stageContainer = container;
		container.appendChild(this.hostElement);
		return { hadPreviousStage };
	}

	markVisible(): HTMLDivElement | null {
		this._visibleContainer = this._stageContainer;
		return this._visibleContainer;
	}

	reveal(): void {
		if (this._visibleContainer) {
			this.hostElement.style.visibility = "visible";
		}
	}

	hide(): void {
		this._visibleContainer = null;
		this.hostElement.style.visibility = "hidden";
	}

	park(): void {
		this._stageContainer = null;
		this.parkingRoot.appendChild(this.hostElement);
	}

	dispose(): void {
		this._stageContainer = null;
		this._visibleContainer = null;
		this.hostElement.remove();
	}
}
