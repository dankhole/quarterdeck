import type { ApprovedRenderer } from "./renderer-admission.js";

/** Transport trust is explicit; privileged IPC continues to use only getMainRenderer. */
export class DesktopRendererRegistry {
	private readonly compareRenderers = new Map<number, ApprovedRenderer>();
	constructor(private readonly getMainRenderer: () => ApprovedRenderer | null) {}

	get = (contentsId?: number): ApprovedRenderer | null => {
		const main = this.getMainRenderer();
		if (main && !main.contents.isDestroyed() && (contentsId === undefined || main.contents.id === contentsId))
			return main;
		if (contentsId === undefined) return null;
		const compare = this.compareRenderers.get(contentsId);
		return compare && !compare.contents.isDestroyed() ? compare : null;
	};

	addCompare(renderer: ApprovedRenderer): () => void {
		if (renderer.role !== "compare" || !renderer.documentUrl)
			throw new Error("Invalid Compare renderer registration.");
		if (this.get(renderer.contents.id)) throw new Error("Renderer already registered.");
		this.compareRenderers.set(renderer.contents.id, renderer);
		return () => {
			if (this.compareRenderers.get(renderer.contents.id) === renderer)
				this.compareRenderers.delete(renderer.contents.id);
		};
	}
}
