// Settings section: harness launch tuning and worktree system prompt.
import * as RadixCollapsible from "@radix-ui/react-collapsible";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useState } from "react";
import { SettingsSwitch } from "@/components/ui/settings-controls";
import type { RuntimeConfigResponse } from "@/runtime/types";
import type { SettingsSectionProps } from "./settings-section-props";

type CodexApprovalsReviewer = RuntimeConfigResponse["codexApprovalsReviewer"];

const CODEX_APPROVALS_REVIEWER_LABELS: Record<CodexApprovalsReviewer, string> = {
	inherit: "Inherit Codex config",
	user: "Ask me",
	auto_review: "Approve for me",
};

function normalizeCodexApprovalsReviewer(value: string): CodexApprovalsReviewer {
	if (value === "user" || value === "auto_review") {
		return value;
	}
	return "inherit";
}

export function HarnessSection({
	fields,
	setField,
	disabled,
	config,
}: SettingsSectionProps & {
	config: RuntimeConfigResponse | null;
}): React.ReactElement {
	const [claudeSettingsExpanded, setClaudeSettingsExpanded] = useState(false);
	const [codexSettingsExpanded, setCodexSettingsExpanded] = useState(false);
	const [systemPromptExpanded, setSystemPromptExpanded] = useState(false);

	const defaultTemplate = config?.worktreeSystemPromptTemplateDefault ?? "";
	const isCustomized = fields.worktreeSystemPromptTemplate !== defaultTemplate;

	const handleResetToDefault = useCallback(() => {
		setField("worktreeSystemPromptTemplate", defaultTemplate);
	}, [setField, defaultTemplate]);

	const ClaudeChevron = claudeSettingsExpanded ? ChevronDown : ChevronRight;
	const CodexChevron = codexSettingsExpanded ? ChevronDown : ChevronRight;
	const PromptChevron = systemPromptExpanded ? ChevronDown : ChevronRight;
	const claudeSettingsSummary = `New/restarted sessions only · ${fields.claudeFullscreenEnabled ? "Fullscreen on" : "Fullscreen off"} · ${fields.statuslineEnabled ? "Status line on" : "Status line off"}`;
	const codexSettingsSummary = `New/restarted sessions only · ${CODEX_APPROVALS_REVIEWER_LABELS[fields.codexApprovalsReviewer]}`;

	return (
		<>
			<h6 className="font-semibold text-text-primary mt-4 mb-1">Harnesses</h6>
			<p className="text-text-secondary text-[13px] mt-0 mb-3">
				Quarterdeck checks the <code className="text-[12px] bg-surface-3 px-1 rounded">PATH</code> inherited from
				the shell that launched it to detect Claude, Codex, and Pi. Choose a harness in the new task dialog;
				unavailable harnesses are shown there with install or upgrade status.
			</p>

			<RadixCollapsible.Root open={claudeSettingsExpanded} onOpenChange={setClaudeSettingsExpanded} className="mt-2">
				<RadixCollapsible.Trigger asChild>
					<button
						type="button"
						className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-surface-2 px-3 py-2 text-left text-[13px] text-text-primary hover:border-border-bright hover:bg-surface-3 data-[state=open]:rounded-b-none"
					>
						<span className="min-w-0">
							<span className="block font-medium">Claude Code</span>
							<span className="block truncate text-[12px] text-text-secondary">{claudeSettingsSummary}</span>
						</span>
						<ClaudeChevron size={16} className="shrink-0 text-text-secondary" />
					</button>
				</RadixCollapsible.Trigger>
				<RadixCollapsible.Content className="overflow-hidden rounded-b-md border-x border-b border-border bg-surface-1">
					<div className="divide-y divide-border">
						<div className="px-3 py-3">
							<SettingsSwitch
								checked={fields.claudeFullscreenEnabled}
								onCheckedChange={(value) => setField("claudeFullscreenEnabled", value)}
								disabled={disabled}
								label="Fullscreen rendering (experimental)"
								description="Uses Claude Code's alternate-screen, virtualized transcript for new or restarted sessions. When off, Quarterdeck keeps Claude on the classic renderer."
							/>
						</div>
						<div className="px-3 py-3">
							<SettingsSwitch
								checked={fields.statuslineEnabled}
								onCheckedChange={(value) => setField("statuslineEnabled", value)}
								disabled={disabled}
								label="Show Quarterdeck status line"
								description="Adds repository, model, context, cost, token, and change metrics to new or restarted Claude sessions."
							/>
						</div>
					</div>
				</RadixCollapsible.Content>
			</RadixCollapsible.Root>

			<RadixCollapsible.Root open={codexSettingsExpanded} onOpenChange={setCodexSettingsExpanded} className="mt-2">
				<RadixCollapsible.Trigger asChild>
					<button
						type="button"
						className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-surface-2 px-3 py-2 text-left text-[13px] text-text-primary hover:border-border-bright hover:bg-surface-3 data-[state=open]:rounded-b-none"
					>
						<span className="min-w-0">
							<span className="block font-medium">Codex</span>
							<span className="block truncate text-[12px] text-text-secondary">{codexSettingsSummary}</span>
						</span>
						<CodexChevron size={16} className="shrink-0 text-text-secondary" />
					</button>
				</RadixCollapsible.Trigger>
				<RadixCollapsible.Content className="overflow-hidden rounded-b-md border-x border-b border-border bg-surface-1">
					<div className="px-3 py-3">
						<div className="flex items-center justify-between gap-3">
							<label
								htmlFor="runtime-settings-codex-approvals-reviewer"
								className="text-text-primary text-[13px]"
							>
								Approval reviewer
							</label>
							<select
								id="runtime-settings-codex-approvals-reviewer"
								name="codexApprovalsReviewer"
								value={fields.codexApprovalsReviewer}
								onChange={(event) =>
									setField(
										"codexApprovalsReviewer",
										normalizeCodexApprovalsReviewer(event.currentTarget.value),
									)
								}
								disabled={disabled}
								className="h-7 min-w-40 rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary outline-none hover:border-border-bright focus:border-border-focus disabled:opacity-40"
							>
								<option value="inherit">Inherit Codex config</option>
								<option value="user">Ask me</option>
								<option value="auto_review">Approve for me</option>
							</select>
						</div>
						<p className="text-text-secondary text-[13px] mt-1 mb-0">
							{fields.codexApprovalsReviewer === "inherit"
								? "Uses the reviewer selected by Codex configuration without a Quarterdeck override."
								: fields.codexApprovalsReviewer === "user"
									? "Forces eligible approval requests to pause for you in new or restarted Codex sessions."
									: "Launches new or restarted Codex sessions with --approve-for-me, routing eligible requests through automatic review while keeping the workspace-write sandbox."}
						</p>
					</div>
				</RadixCollapsible.Content>
			</RadixCollapsible.Root>

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
