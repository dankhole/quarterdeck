import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import type { SourceEditorAction, SourceEditorActionContext } from "@/components/editor/source-editor-context";
import type { WorkdirSearchScope } from "@/hooks/search/search-scope";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { toErrorMessage } from "@/utils/to-error-message";
import {
	CODE_NAVIGATION_LABELS,
	type CodeNavigationConfig,
	type CodeNavigationOperation,
	type CodeNavigationResult,
	type CodeNavigationSource,
	codeNavigationUnavailableReason,
} from "./code-navigation";

export interface UseCodeNavigationOptions {
	projectId: string | null;
	scopeKey: string;
	scope: WorkdirSearchScope;
	config: CodeNavigationConfig | null;
	source: CodeNavigationSource | null;
}

export interface UseCodeNavigationResult {
	actions: readonly SourceEditorAction[];
	result: CodeNavigationResult | null;
	dismiss: () => void;
}

export function useCodeNavigation(options: UseCodeNavigationOptions): UseCodeNavigationResult {
	const { projectId, scopeKey, scope, source, config } = options;
	const [outcome, setOutcome] = useState<{
		scopeKey: string;
		configKey: string;
		result: CodeNavigationResult;
	} | null>(null);
	const requestRef = useRef(0);
	const configKey = JSON.stringify([config?.codeNavigationEnabled, config?.lspServers]);
	const latestRef = useRef({ ...options, configKey });
	latestRef.current = { ...options, configKey };
	const result = outcome?.scopeKey === scopeKey && outcome.configKey === configKey ? outcome.result : null;
	const dismiss = useCallback(() => {
		requestRef.current += 1;
		setOutcome(null);
	}, []);

	useEffect(() => {
		dismiss();
		return () => {
			requestRef.current += 1;
		};
	}, [scopeKey, configKey, dismiss]);

	useEffect(() => {
		requestRef.current += 1;
		// Keep a completed references/definitions list available while visiting its results.
		setOutcome((current) => (current?.result.status === "locations" ? current : null));
	}, [source?.path, source?.content, source?.eligibility]);

	const run = useCallback(
		async (operation: CodeNavigationOperation, context: SourceEditorActionContext) => {
			const requestId = ++requestRef.current;
			const setResult = (next: CodeNavigationResult) => {
				setOutcome({ scopeKey, configKey, result: next });
				if (next.status === "unavailable" || next.status === "error") {
					showAppToast({
						intent: "danger",
						message: `${CODE_NAVIGATION_LABELS[operation]}: ${next.message}`,
					});
				}
			};
			const unavailable = codeNavigationUnavailableReason({ projectId, scope, source, config });
			if (unavailable) {
				setResult({ status: "unavailable", operation, message: unavailable });
				return;
			}
			if (!source || context.path !== source.path || context.content !== source.content) return;
			const isCurrent = () =>
				requestRef.current === requestId &&
				latestRef.current.scopeKey === scopeKey &&
				latestRef.current.configKey === configKey &&
				latestRef.current.source?.eligibility === "eligible" &&
				latestRef.current.source.path === context.path &&
				latestRef.current.source.content === context.content;
			setResult({ status: "busy", operation });
			const request = {
				...scope,
				path: context.path,
				position: context.position,
				documentVersion: context.documentVersion,
				content: context.content,
			};
			try {
				const client = getRuntimeTrpcClient(projectId).project.codeNavigation;
				if (operation === "hover") {
					const response = await client.hover.mutate(request);
					if (!isCurrent() || response.documentVersion !== context.documentVersion) return;
					setResult(
						response.status === "ok"
							? { status: "hover", operation, contents: response.contents }
							: { ...response, operation },
					);
				} else {
					const response =
						operation === "definition"
							? await client.definition.mutate(request)
							: await client.references.mutate({ ...request, includeDeclaration: true });
					if (!isCurrent() || response.documentVersion !== context.documentVersion) return;
					setResult(
						response.status === "ok"
							? {
									status: "locations",
									operation,
									sourcePath: context.path,
									locations: response.locations,
									truncated: response.truncated,
								}
							: { ...response, operation },
					);
				}
			} catch (error) {
				if (isCurrent()) setResult({ status: "error", operation, message: toErrorMessage(error) });
			}
		},
		[projectId, scopeKey, scope, source, config, configKey],
	);

	const actions = useMemo(
		() =>
			(Object.keys(CODE_NAVIGATION_LABELS) as CodeNavigationOperation[]).map(
				(operation): SourceEditorAction => ({
					id: `code-navigation-${operation}`,
					label: CODE_NAVIGATION_LABELS[operation],
					disabled: result?.status === "busy",
					onSelect: (context) => {
						void run(operation, context);
					},
				}),
			),
		[run, result?.status],
	);
	return { actions, result, dismiss };
}
