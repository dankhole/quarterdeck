// Settings section: harness launch tuning and worktree system prompt.
import * as RadixCollapsible from "@radix-ui/react-collapsible";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useState } from "react";
import type { RuntimeConfigResponse } from "@/runtime/types";
import type { SettingsSectionProps } from "./settings-section-props";

export function HarnessSection({
	fields,
	setField,
	disabled,
	config,
}: SettingsSectionProps & {
	config: RuntimeConfigResponse | null;
}): React.ReactElement {
	const [systemPromptExpanded, setSystemPromptExpanded] = useState(false);

	const defaultTemplate = config?.worktreeSystemPromptTemplateDefault ?? "";
	const isCustomized = fields.worktreeSystemPromptTemplate !== defaultTemplate;

	const handleResetToDefault = useCallback(() => {
		setField("worktreeSystemPromptTemplate", defaultTemplate);
	}, [setField, defaultTemplate]);

	const PromptChevron = systemPromptExpanded ? ChevronDown : ChevronRight;

	return (
		<>
			<h6 className="font-semibold text-text-primary mt-4 mb-1">Harnesses</h6>
			<p className="text-text-secondary text-[13px] mt-0 mb-3">
				Quarterdeck checks the <code className="text-[12px] bg-surface-3 px-1 rounded">PATH</code> inherited from
				the shell that launched it to detect Claude, Codex, and Pi. Choose a harness in the new task dialog;
				unavailable harnesses are shown there with install or upgrade status.
			</p>

			<RadixCollapsible.Root open={systemPromptExpanded} onOpenChange={setSystemPromptExpanded} className="mt-2">
				<RadixCollapsible.Trigger asChild>
					<button
						type="button"
						className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-surface-2 px-3 py-2 text-left text-[13px] text-text-primary hover:border-border-bright hover:bg-surface-3"
					>
						<span className="min-w-0">
							<span className="block font-medium">Worktree context prompt</span>
							<span className="block truncate text-[12px] text-text-secondary">
								{isCustomized ? "Custom launch context template" : "Default launch context template"}
							</span>
						</span>
						<PromptChevron size={16} className="shrink-0 text-text-secondary" />
					</button>
				</RadixCollapsible.Trigger>
				<RadixCollapsible.Content className="mt-2">
					<div className="flex items-center justify-between gap-3">
						<p className="text-text-secondary text-[13px] my-0">
							Sent to worktree-launched harnesses as Claude system-prompt context or Codex developer
							instructions.
						</p>
						{isCustomized ? (
							<button
								type="button"
								onClick={handleResetToDefault}
								disabled={disabled}
								className="shrink-0 text-[12px] text-accent hover:text-accent-hover bg-transparent border-none p-0 cursor-pointer disabled:opacity-40"
							>
								Reset to default
							</button>
						) : null}
					</div>
					<p className="text-text-secondary text-[13px] mt-1 mb-2">
						Supports <code className="text-[12px] bg-surface-3 px-1 rounded">{"{{cwd}}"}</code>,{" "}
						<code className="text-[12px] bg-surface-3 px-1 rounded">{"{{project_path}}"}</code>, and{" "}
						<code className="text-[12px] bg-surface-3 px-1 rounded">{"{{detached_head_note}}"}</code>{" "}
						placeholders.
					</p>
					<textarea
						id="runtime-settings-worktree-system-prompt"
						value={fields.worktreeSystemPromptTemplate}
						onChange={(e) => setField("worktreeSystemPromptTemplate", e.target.value)}
						disabled={disabled}
						rows={8}
						className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-[13px] text-text-primary font-mono leading-relaxed resize-y focus:border-border-focus focus:outline-none disabled:opacity-40"
						placeholder="System prompt template for worktree harnesses..."
					/>
				</RadixCollapsible.Content>
			</RadixCollapsible.Root>
		</>
	);
}
