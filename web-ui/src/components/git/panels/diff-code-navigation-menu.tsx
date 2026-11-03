import * as ContextMenu from "@radix-ui/react-context-menu";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { SOURCE_EDITOR_NAVIGATION_SHORTCUTS } from "@/components/editor/source-editor-navigation";
import {
	createDiffActionContext,
	DIFF_OLD_SIDE_UNAVAILABLE,
	diffPointerTextOffset,
} from "@/hooks/git/diff-code-navigation";
import type { ReviewDocument } from "@/hooks/git/review-document";
import {
	type DiffCodeNavigationOptions,
	type DiffCodeNavigationTarget,
	useDiffCodeNavigation,
} from "@/hooks/git/use-diff-code-navigation";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { CodeNavigationLocation } from "@/runtime/types";
import { isMacPlatform } from "@/utils/platform";
import { CodeNavigationResults } from "./code-navigation-results";
import { CONTEXT_MENU_ITEM_CLASS } from "./context-menu-utils";

function keyboardOperation(
	event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): "definition" | "references" | "hover" | null {
	if (event.shiftKey) return null;
	const definitionModifier = isMacPlatform ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
	if (definitionModifier && !event.altKey && event.key.toLowerCase() === "b") return "definition";
	if (event.altKey && !event.metaKey && !event.ctrlKey && event.key === "F7") return "references";
	if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === (isMacPlatform ? "j" : "q"))
		return "hover";
	return null;
}

export function DiffCodeNavigationMenu({
	document,
	options,
	onNavigate,
	children,
}: {
	document: ReviewDocument;
	options: DiffCodeNavigationOptions;
	onNavigate: (location: CodeNavigationLocation) => void;
	children: ReactNode;
}): React.ReactElement {
	const surfaceRef = useRef<HTMLDivElement>(null);
	const focusTransferredRef = useRef(false);
	const navigate = useCallback(
		(location: CodeNavigationLocation) => {
			focusTransferredRef.current = true;
			onNavigate(location);
		},
		[onNavigate],
	);
	const navigation = useDiffCodeNavigation(document, { ...options, onNavigate: navigate });
	useEffect(() => {
		if (navigation.result) focusTransferredRef.current = false;
	}, [navigation.result]);
	const readFile = useCallback(
		async (path: string) => {
			if (!options.projectId) return null;
			return getRuntimeTrpcClient(options.projectId).project.getFileContent.query({
				taskId: options.scope.taskId,
				path,
			});
		},
		[options.projectId, options.scope.taskId],
	);
	const [target, setTarget] = useState<DiffCodeNavigationTarget>({ context: null, unavailableReason: null });
	const pointerTarget = (
		elementTarget: EventTarget,
		container: HTMLElement,
		x: number,
		y: number,
	): DiffCodeNavigationTarget => {
		const element = elementTarget instanceof Element ? elementTarget.closest<HTMLElement>(".kb-diff-text") : null;
		const row = element?.closest<HTMLElement>("[data-code-navigation-side]");
		if (!element || !row || !container.contains(row))
			return { context: null, unavailableReason: "Right-click a symbol in the diff text to choose its position." };
		if (row.dataset.codeNavigationSide === "old")
			return { context: null, unavailableReason: DIFF_OLD_SIDE_UNAVAILABLE };
		const character = diffPointerTextOffset(element, x, y);
		const context =
			character === null
				? null
				: createDiffActionContext(document, Number(row.dataset.diffLine), character, navigation.documentVersion);
		return {
			context,
			unavailableReason: context
				? null
				: "Could not determine the symbol position. Click directly on the code text.",
		};
	};
	return (
		<>
			<ContextMenu.Root>
				<ContextMenu.Trigger asChild>
					<div
						ref={surfaceRef}
						tabIndex={0}
						role="region"
						aria-label="Diff code navigation"
						onClickCapture={(event) => {
							// Resolve before the inner occurrence highlighter replaces syntax spans.
							if (!(event.target instanceof Element) || !event.target.closest(".kb-diff-text")) return;
							const next = pointerTarget(event.target, event.currentTarget, event.clientX, event.clientY);
							if (
								!event.metaKey &&
								!event.ctrlKey &&
								(event.detail > 1 || !event.currentTarget.ownerDocument.getSelection()?.isCollapsed)
							)
								return;
							setTarget(next);
							event.currentTarget.focus({ preventScroll: true });
							if (
								(isMacPlatform ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
								!event.altKey &&
								!event.shiftKey
							) {
								event.preventDefault();
								const action = navigation.actions.find((item) => item.id === "code-navigation-definition");
								if (action && !action.disabled) navigation.select(action, next);
							}
						}}
						onKeyDown={(event) => {
							if (event.target !== event.currentTarget) return;
							const operation = keyboardOperation(event);
							const action = navigation.actions.find((item) => item.id === `code-navigation-${operation}`);
							if (action && !action.disabled) {
								event.preventDefault();
								event.stopPropagation();
								navigation.select(action, target);
							}
						}}
						onContextMenu={(event) => {
							// Keyboard context menus use the last clicked caret, not the wrapper's coordinates.
							if (event.button === 0 && event.clientX === 0 && event.clientY === 0) return;
							setTarget(pointerTarget(event.target, event.currentTarget, event.clientX, event.clientY));
						}}
					>
						{children}
					</div>
				</ContextMenu.Trigger>
				<ContextMenu.Portal>
					<ContextMenu.Content className="z-50 min-w-56 rounded-md border border-border bg-surface-1 p-1 shadow-xl">
						{navigation.actions.map((action) => (
							<ContextMenu.Item
								key={action.id}
								className={`${CONTEXT_MENU_ITEM_CLASS} flex items-center justify-between gap-6`}
								disabled={action.disabled}
								onSelect={() => navigation.select(action, target)}
							>
								<span>{action.label}</span>
								{SOURCE_EDITOR_NAVIGATION_SHORTCUTS[action.id] ? (
									<span className="text-[10px] text-text-tertiary">
										{SOURCE_EDITOR_NAVIGATION_SHORTCUTS[action.id]}
									</span>
								) : null}
							</ContextMenu.Item>
						))}
					</ContextMenu.Content>
				</ContextMenu.Portal>
			</ContextMenu.Root>
			{navigation.result ? (
				<CodeNavigationResults
					result={navigation.result}
					referencesOptions={navigation.referencesOptions}
					onDismiss={navigation.dismiss}
					onNavigate={navigate}
					readFile={readFile}
					onRestoreFocus={() => {
						// A direct single-definition result can bypass the popup's selection handler.
						if (!focusTransferredRef.current) surfaceRef.current?.focus({ preventScroll: true });
					}}
				/>
			) : null}
		</>
	);
}
