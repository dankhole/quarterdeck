import { type CompareWindowTarget, parseCompareWindowTarget } from "../../../../src/shared/compare-window-contract";

export type BrowserSurface =
	| { readonly kind: "app" }
	| { readonly kind: "compare"; readonly target: CompareWindowTarget }
	| { readonly kind: "invalid-compare" };

/** A malformed auxiliary request must never mount the normal application's side effects. */
export function resolveBrowserSurface(url: URL): BrowserSurface {
	if (!url.searchParams.has("surface")) return { kind: "app" };
	const target = parseCompareWindowTarget(url);
	return target ? { kind: "compare", target } : { kind: "invalid-compare" };
}
