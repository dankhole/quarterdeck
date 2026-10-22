import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type TaskImageSource, useTaskImageSource } from "@/hooks/board/use-task-image-source";
import { ProjectSyncContext, type ProjectSyncContextValue } from "@/providers/project-provider";
import type { TaskImage } from "@/types";

const { fetchTaskImageData } = vi.hoisted(() => ({ fetchTaskImageData: vi.fn() }));
vi.mock("@/runtime/task-image-query", () => ({ fetchTaskImageData }));

type ActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

const storedImage: TaskImage = { id: "img-1", mimeType: "image/png", sha256: "a".repeat(64), byteLength: 1 };

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function Harness({ image, onSource }: { image: TaskImage; onSource: (source: TaskImageSource) => void }): null {
	onSource(useTaskImageSource(image));
	return null;
}

describe("useTaskImageSource", () => {
	let container: HTMLDivElement;
	let root: Root;
	let source: TaskImageSource;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT;
		(globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		root = createRoot(container);
		fetchTaskImageData.mockReset();
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		if (previousActEnvironment === undefined) delete (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT;
		else (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
	});

	async function render(image: TaskImage, boardProjectId: string | null): Promise<void> {
		const value = { boardProjectId } as unknown as ProjectSyncContextValue;
		await act(async () =>
			root.render(
				<ProjectSyncContext.Provider value={value}>
					<Harness
						image={image}
						onSource={(next) => {
							source = next;
						}}
					/>
				</ProjectSyncContext.Provider>,
			),
		);
	}

	it("renders inline uploads immediately without a runtime read", async () => {
		await render({ id: "img-1", mimeType: "image/png", data: "YQ==" }, "project-1");
		expect(source).toEqual({ src: "data:image/png;base64,YQ==", status: "ready" });
		expect(fetchTaskImageData).not.toHaveBeenCalled();
	});

	it("loads stored references from the board's project", async () => {
		fetchTaskImageData.mockResolvedValue("Yg==");
		await render(storedImage, "project-1");
		expect(fetchTaskImageData).toHaveBeenCalledWith("project-1", storedImage.sha256);
		expect(source).toEqual({ src: "data:image/png;base64,Yg==", status: "ready" });
	});

	it("reports missing blobs and ignores a late result after the project changes", async () => {
		const first = deferred<string | null>();
		fetchTaskImageData.mockReturnValueOnce(first.promise).mockResolvedValueOnce(null);
		await render(storedImage, "project-1");
		expect(source.status).toBe("loading");

		await render(storedImage, "project-2");
		await act(async () => first.resolve("Yg=="));
		expect(source).toEqual({ src: null, status: "missing" });
	});
});
