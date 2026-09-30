import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectOrganization, ProjectOrganizationResponse } from "@/runtime/types";
import { useProjectGroups } from "./use-project-groups";

const mutate = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/trpc-client", () => ({ getRuntimeTrpcClient: () => ({ projects: { organize: { mutate } } }) }));
vi.mock("@/components/app-toaster", () => ({ notifyError: vi.fn() }));
const organization: ProjectOrganization = {
	id: "index",
	revision: 1,
	groups: [{ id: "g", name: "Work" }],
	membership: {},
	projectOrder: [],
};
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previous = environment.IS_REACT_ACT_ENVIRONMENT;
afterEach(() => {
	environment.IS_REACT_ACT_ENVIRONMENT = previous;
	vi.clearAllMocks();
});
describe("project group saves", () => {
	it("blocks overlapping mutations and restores the latest authoritative state on failure", async () => {
		environment.IS_REACT_ACT_ENVIRONMENT = true;
		let settle: (result: ProjectOrganizationResponse) => void = () => {};
		mutate.mockImplementation(
			() =>
				new Promise<ProjectOrganizationResponse>((resolve) => {
					settle = resolve;
				}),
		);
		let latest: ReturnType<typeof useProjectGroups> | null = null;
		const apply = vi.fn();
		function Harness({ value }: { value: ProjectOrganization }) {
			latest = useProjectGroups({
				organization: value,
				projects: [],
				currentProjectId: null,
				onOrganization: apply,
			});
			return null;
		}
		const container = document.createElement("div");
		const root = createRoot(container);
		await act(async () => root.render(<Harness value={organization} />));
		const read = (): ReturnType<typeof useProjectGroups> => {
			if (!latest) throw new Error("Hook not mounted");
			return latest;
		};
		let result: Promise<boolean> = Promise.resolve(false);
		await act(async () => {
			result = read().execute({ type: "rename", groupId: "g", name: "Tools" });
		});
		expect(read().organization?.groups[0]?.name).toBe("Tools");
		expect(await read().execute({ type: "remove", groupId: "g" })).toBe(false);
		expect(mutate).toHaveBeenCalledOnce();
		const newer = { ...organization, revision: 3, groups: [{ id: "g", name: "Team" }] };
		await act(async () => root.render(<Harness value={newer} />));
		expect(read().organization?.groups[0]?.name).toBe("Team");
		await act(async () => {
			settle({ ok: false, error: "Changed elsewhere", organization: newer });
			await result;
		});
		expect(await result).toBe(false);
		expect(read().pending).toBe(false);
		expect(read().organization).toEqual(newer);
		expect(apply).toHaveBeenCalledWith(newer);
		await act(async () => root.unmount());
	});
});
