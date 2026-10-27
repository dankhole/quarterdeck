import { describe, expect, it } from "vitest";
import {
	buildCompareWindowPath,
	type CompareWindowTarget,
	compareWindowTargetSchema,
	parseCompareWindowTarget,
} from "../../src/shared/compare-window-contract.js";

const target: CompareWindowTarget = {
	projectId: "project-1",
	taskId: "task-1",
	taskCreatedAt: 123,
	sourceRef: "feature/a+b#c",
	targetRef: "main~1",
	includeUncommitted: false,
	threeDotDiff: true,
	selectedPath: "src/unicode λ.ts",
};

describe("Compare window navigation contract", () => {
	it("round trips task and home selections without accepting origin or filesystem authority", () => {
		for (const input of [target, { ...target, taskId: null, taskCreatedAt: undefined }]) {
			const path = buildCompareWindowPath(input);
			expect(path).toMatch(/^\/project-1\?surface=compare&/u);
			for (const origin of ["https://localhost:8443", "app://quarterdeck"]) {
				expect(parseCompareWindowTarget(new URL(path, origin))).toEqual(input);
			}
		}
	});

	it("rejects ambiguous parameters, malformed booleans, identity and path traversal", () => {
		const path = buildCompareWindowPath(target);
		for (const suffix of ["&surface=compare", "&sourceRef=other", "&url=https://evil.test", "#fragment"]) {
			expect(parseCompareWindowTarget(new URL(`${path}${suffix}`, "app://quarterdeck"))).toBeNull();
		}
		for (const replacement of [
			{ projectId: "../outside" },
			{ taskCreatedAt: undefined },
			{ taskCreatedAt: Number.POSITIVE_INFINITY },
			{ taskId: null },
			{ sourceRef: "" },
			{ sourceRef: "main\n" },
			{ selectedPath: "../secret" },
			{ selectedPath: "/absolute" },
			{ selectedPath: "a\\b" },
			{ url: "https://evil.test" },
		])
			expect(compareWindowTargetSchema.safeParse({ ...target, ...replacement }).success).toBe(false);
		for (const replacement of [
			["threeDotDiff=true", "threeDotDiff=1"],
			["includeUncommitted=false", "includeUncommitted="],
			["taskCreatedAt=123", "taskCreatedAt=1e2"],
			["/project-1?", "/project-1/extra?"],
			["/project-1?", "/%ZZ?"],
		]) {
			expect(
				parseCompareWindowTarget(new URL(path.replace(replacement[0], replacement[1]), "app://quarterdeck")),
			).toBeNull();
		}
	});
});
