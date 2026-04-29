import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOpenProject } from "@/hooks/project/use-open-project";

const runCommandMutateMock = vi.hoisted(() => vi.fn());
const getRuntimeTrpcClientMock = vi.hoisted(() => vi.fn());
const showAppToastMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: getRuntimeTrpcClientMock,
}));

vi.mock("@/components/app-toaster", () => ({
	showAppToast: showAppToastMock,
}));

type HookSnapshot = ReturnType<typeof useOpenProject>;

function requireSnapshot(snapshot: HookSnapshot | null): HookSnapshot {
	if (!snapshot) {
		throw new Error("Expected hook snapshot.");
	}
	return snapshot;
}

function HookHarness({
	runtimePlatform,
	onSnapshot,
}: {
	runtimePlatform: Parameters<typeof useOpenProject>[0]["runtimePlatform"];
	onSnapshot: (snapshot: HookSnapshot) => void;
}): null {
	const snapshot = useOpenProject({
		currentProjectId: "project-1",
		projectPath: "/repo",
		runtimePlatform,
	});

	useEffect(() => {
		onSnapshot(snapshot);
	}, [onSnapshot, snapshot]);

	return null;
}

describe("useOpenProject", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		runCommandMutateMock.mockReset();
		runCommandMutateMock.mockResolvedValue({
			exitCode: 0,
			stdout: "",
			stderr: "",
			combinedOutput: "",
			durationMs: 1,
		});
		getRuntimeTrpcClientMock.mockReset();
		getRuntimeTrpcClientMock.mockReturnValue({
			runtime: {
				runCommand: {
					mutate: runCommandMutateMock,
				},
			},
		});
		showAppToastMock.mockReset();
		localStorage.clear();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("uses the runtime platform, not the browser platform, when opening projects", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					runtimePlatform="linux"
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const snapshot = requireSnapshot(latestSnapshot);
		expect(snapshot.openTargetOptions.some((option) => option.id === "xcode")).toBe(false);
		expect(snapshot.openTargetOptions.some((option) => option.id === "rider")).toBe(true);

		await act(async () => {
			snapshot.onOpenProject();
			await Promise.resolve();
		});

		expect(getRuntimeTrpcClientMock).toHaveBeenCalledWith("project-1");
		expect(runCommandMutateMock).toHaveBeenCalledWith({ command: "code '/repo'" });
		expect(showAppToastMock).not.toHaveBeenCalled();
	});
});
