// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildCompareWindowPath, type CompareWindowTarget } from "../../../../src/shared/compare-window-contract";
import { resolveBrowserSurface } from "./compare-window-bootstrap";

const target: CompareWindowTarget = {
	projectId: "p1",
	taskId: null,
	sourceRef: "topic",
	targetRef: "main",
	includeUncommitted: false,
	threeDotDiff: true,
};

describe("Compare surface bootstrap", () => {
	it("selects the standalone surface from a captured URL", () => {
		expect(resolveBrowserSurface(new URL(buildCompareWindowPath(target), "http://localhost"))).toEqual({
			kind: "compare",
			target,
		});
	});
	it("leaves ordinary project URLs in the normal app", () => {
		expect(resolveBrowserSurface(new URL("http://localhost/p1"))).toEqual({ kind: "app" });
	});
	it.each([
		"/?surface=compare",
		"/p1?surface=compare",
		"/p1?surface=other",
		`${buildCompareWindowPath(target)}&surface=compare`,
		`${buildCompareWindowPath(target)}&taskId=task-1`,
		`${buildCompareWindowPath(target)}&selectedPath=../escape`,
		`${buildCompareWindowPath(target)}#unexpected`,
	])("fails closed instead of mounting App for %s", (path) => {
		expect(resolveBrowserSurface(new URL(path, "http://localhost"))).toEqual({ kind: "invalid-compare" });
	});
});
