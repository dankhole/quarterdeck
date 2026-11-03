import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import type { SourceEditorAction, SourceEditorActionContext } from "@/components/editor/source-editor-context";
import type { WorkdirSearchScope } from "@/hooks/search/search-scope";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { CodeNavigationLocation } from "@/runtime/types";
import { toErrorMessage } from "@/utils/to-error-message";
import {
	CODE_NAVIGATION_LABELS,
	type CodeNavigationConfig,
	type CodeNavigationOperation,
	type CodeNavigationReferencesOptions,
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
	/** A single unambiguous definition opens immediately; usages always retain their list. */
	onNavigate?: (location: CodeNavigationLocation) => void;
}

export interface UseCodeNavigationResult {
	actions: readonly SourceEditorAction[];
	result: CodeNavigationResult | null;
	referencesOptions: CodeNavigationReferencesOptions;
	dismiss: () => void;
}

export function useCodeNavigation(options: UseCodeNavigationOptions): UseCodeNavigationResult {
	const { projectId, scope, source, config } = options;
	const scopeKey = JSON.stringify([projectId, options.scopeKey, scope.taskId, scope.baseRef, scope.ref]);
	const [ignoreComments, setIgnoreComments] = useState(false);
	const ignoreCommentsRef = useRef(false);
	const referencesContextRef = useRef<{
		context: SourceEditorActionContext;
		scopeKey: string;
		configKey: string;
	} | null>(null);
	const [outcome, setOutcome] = useState<{
		scopeKey: string;
		configKey: string;
		result: CodeNavigationResult;
	} | null>(null);
	const requestRef = useRef(0);
	const configKey = JSON.stringify([config?.codeNavigationEnabled, config?.lspServers]);
	const latestRef = useRef({ ...options, scopeKey, configKey });
	latestRef.current = { ...options, scopeKey, configKey };
	const result = outcome?.scopeKey === scopeKey && outcome.configKey === configKey ? outcome.result : null;
	const dismiss = useCallback(() => {
		requestRef.current += 1;
		referencesContextRef.current = null;
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
		async (
			operation: CodeNavigationOperation,
			context: SourceEditorActionContext,
			filterComments = ignoreCommentsRef.current,
		) => {
			const latest = latestRef.current;
			if (
				latest.scopeKey !== scopeKey ||
				latest.configKey !== configKey ||
				latest.source?.path !== source?.path ||
				latest.source?.content !== source?.content ||
				latest.source?.eligibility !== source?.eligibility
			)
				return;
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
			if (operation === "references") referencesContextRef.current = { context, scopeKey, configKey };
			else referencesContextRef.current = null;
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
							: await client.references.mutate({
									...request,
									includeDeclaration: true,
									...(filterComments ? { ignoreComments: true } : {}),
								});
					if (!isCurrent() || response.documentVersion !== context.documentVersion) return;
					if (
						operation === "references" &&
						filterComments &&
						response.status === "ok" &&
						!("ignoreComments" in response && response.ignoreComments === true)
					) {
						setResult({
							status: "unavailable",
							operation,
							message: "Ignore comments is unavailable. Upgrade the Quarterdeck runtime and try again.",
						});
						return;
					}
					if (
						operation === "definition" &&
						response.status === "ok" &&
						response.locations.length === 1 &&
						!response.truncated &&
						latestRef.current.onNavigate
					) {
						setOutcome(null);
						latestRef.current.onNavigate(response.locations[0]!);
						return;
					}
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
	const captured = referencesContextRef.current;
	const canRerunReferences =
		captured !== null &&
		captured.scopeKey === scopeKey &&
		captured.configKey === configKey &&
		source?.eligibility === "eligible" &&
		source.path === captured.context.path &&
		source.content === captured.context.content;
	const toggleIgnoreComments = useCallback(() => {
		const captured = referencesContextRef.current;
		if (
			latestRef.current.scopeKey !== scopeKey ||
			latestRef.current.configKey !== configKey ||
			!captured ||
			captured.scopeKey !== scopeKey ||
			captured.configKey !== configKey ||
			source?.eligibility !== "eligible" ||
			source.path !== captured.context.path ||
			source.content !== captured.context.content
		)
			return;
		const next = !ignoreCommentsRef.current;
		ignoreCommentsRef.current = next;
		setIgnoreComments(next);
		void run("references", captured.context, next);
	}, [scopeKey, configKey, source, run]);
	return {
		actions,
		result,
		dismiss,
		referencesOptions: { ignoreComments, disabled: !canRerunReferences, onToggle: toggleIgnoreComments },
	};
}
