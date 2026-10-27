import * as ContextMenu from "@radix-ui/react-context-menu";
import { type ReactNode, useState } from "react";
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
import type { CodeNavigationLocation } from "@/runtime/types";
import { CodeNavigationResults } from "./code-navigation-results";
import { CONTEXT_MENU_ITEM_CLASS } from "./context-menu-utils";

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
	const navigation = useDiffCodeNavigation(document, options);
	const [target, setTarget] = useState<DiffCodeNavigationTarget>({ context: null, unavailableReason: null });
	return (
		<>
			<ContextMenu.Root>
				<ContextMenu.Trigger asChild>
					<div
						onContextMenu={(event) => {
							const element =
								event.target instanceof Element ? event.target.closest<HTMLElement>(".kb-diff-text") : null;
							const row = element?.closest<HTMLElement>("[data-code-navigation-side]");
							if (!element || !row || !event.currentTarget.contains(row)) {
								setTarget({
									context: null,
									unavailableReason: "Right-click a symbol in the diff text to choose its position.",
								});
								return;
							}
							if (row.dataset.codeNavigationSide === "old") {
								setTarget({ context: null, unavailableReason: DIFF_OLD_SIDE_UNAVAILABLE });
								return;
							}
							const character = diffPointerTextOffset(element, event.clientX, event.clientY);
							const context =
								character === null
									? null
									: createDiffActionContext(
											document,
											Number(row.dataset.diffLine),
											character,
											navigation.documentVersion,
										);
							setTarget({
								context,
								unavailableReason: context
									? null
									: "Could not determine the symbol position. Right-click directly on the code text.",
							});
						}}
					>
						{children}
					</div>
				</ContextMenu.Trigger>
				<ContextMenu.Portal>
					<ContextMenu.Content className="z-50 min-w-48 rounded-md border border-border bg-surface-1 p-1 shadow-xl">
						{navigation.actions.map((action) => (
							<ContextMenu.Item
								key={action.id}
								className={CONTEXT_MENU_ITEM_CLASS}
								disabled={action.disabled}
								onSelect={() => navigation.select(action, target)}
							>
								{action.label}
							</ContextMenu.Item>
						))}
					</ContextMenu.Content>
				</ContextMenu.Portal>
			</ContextMenu.Root>
			{navigation.result ? (
				<CodeNavigationResults result={navigation.result} onDismiss={navigation.dismiss} onNavigate={onNavigate} />
			) : null}
		</>
	);
}
