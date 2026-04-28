import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type UseTrpcQueryResult, useTrpcQuery } from "@/runtime/use-trpc-query";

interface TestPayload {
	revision: number;
	label: string;
	items: string[];
}

function HookHarness({
	queryFn,
	isDataEqual,
	onData,
	onQuery,
}: {
	queryFn: () => Promise<TestPayload>;
	isDataEqual?: (previousData: TestPayload, nextData: TestPayload) => boolean;
	onData: (data: TestPayload | null) => void;
	onQuery: (query: UseTrpcQueryResult<TestPayload>) => void;
}): null {
	const query = useTrpcQuery<TestPayload>({
		enabled: true,
		queryFn,
		isDataEqual,
	});

	onQuery(query);

	useEffect(() => {
		onData(query.data);
	}, [onData, query.data]);

	return null;
}

describe("useTrpcQuery", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
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
		vi.restoreAllMocks();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("suppresses equal revision updates without serializing the response", async () => {
		const firstPayload: TestPayload = { revision: 1, label: "first", items: ["a", "b"] };
		const sameRevisionPayload: TestPayload = { revision: 1, label: "same revision", items: ["c"] };
		const nextRevisionPayload: TestPayload = { revision: 2, label: "next revision", items: ["d"] };
		const queryFn = vi
			.fn<() => Promise<TestPayload>>()
			.mockResolvedValueOnce(firstPayload)
			.mockResolvedValueOnce(sameRevisionPayload)
			.mockResolvedValueOnce(nextRevisionPayload);
		const stringifySpy = vi.spyOn(JSON, "stringify");
		const dataSnapshots: Array<TestPayload | null> = [];
		const latestQueryRef: { current: UseTrpcQueryResult<TestPayload> | null } = { current: null };
		const getLatestQuery = (): UseTrpcQueryResult<TestPayload> => {
			if (!latestQueryRef.current) {
				throw new Error("Expected hook result to be captured.");
			}
			return latestQueryRef.current;
		};

		await act(async () => {
			root.render(
				<HookHarness
					queryFn={queryFn}
					isDataEqual={(previousData, nextData) => previousData.revision === nextData.revision}
					onData={(data) => dataSnapshots.push(data)}
					onQuery={(query) => {
						latestQueryRef.current = query;
					}}
				/>,
			);
			await Promise.resolve();
		});

		expect(getLatestQuery().data).toBe(firstPayload);

		await act(async () => {
			await getLatestQuery().refetch();
		});

		expect(getLatestQuery().data).toBe(firstPayload);
		expect(dataSnapshots.filter(Boolean)).toHaveLength(1);

		await act(async () => {
			await getLatestQuery().refetch();
		});

		expect(getLatestQuery().data).toBe(nextRevisionPayload);
		expect(dataSnapshots.filter(Boolean)).toEqual([firstPayload, nextRevisionPayload]);
		expect(stringifySpy).not.toHaveBeenCalled();
	});
});
