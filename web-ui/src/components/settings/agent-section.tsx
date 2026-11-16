// Settings section: harness launch tuning and worktree system prompt.
import * as RadixCollapsible from "@radix-ui/react-collapsible";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useState } from "react";
import { SettingsSwitch } from "@/components/ui/settings-controls";
import type { RuntimeConfigResponse } from "@/runtime/types";
import type { SettingsSectionProps } from "./settings-section-props";

type CodexApprovalsReviewer = RuntimeConfigResponse["codexApprovalsReviewer"];
type ClaudeLaunchPermissionMode = RuntimeConfigResponse["claudeLaunchPermissionMode"];

const CLAUDE_PERMISSION_MODE_LABELS: Record<ClaudeLaunchPermissionMode, string> = {
	inherit: "Inherit Claude config",
	default: "Default prompts",
	acceptEdits: "Accept edits",
	plan: "Plan only",
	auto: "Auto mode (preview)",
	dontAsk: "Deny unapproved tools",
	bypassPermissions: "Bypass permissions (dangerous)",
};

function normalizeClaudeLaunchPermissionMode(value: string): ClaudeLaunchPermissionMode {
	if (
		value === "default" ||
		value === "acceptEdits" ||
		value === "plan" ||
		value === "auto" ||
		value === "dontAsk" ||
		value === "bypassPermissions"
	) {
		return value;
	}
	return "inherit";
}

const CODEX_APPROVALS_REVIEWER_LABELS: Record<CodexApprovalsReviewer, string> = {
	inherit: "Inherit Codex config",
	user: "Ask me",
	auto_review: "Approve for me",
	dangerously_bypass: "Dangerously bypass approvals and sandbox",
};

function normalizeCodexApprovalsReviewer(value: string): CodexApprovalsReviewer {
	if (value === "user" || value === "auto_review" || value === "dangerously_bypass") {
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
	const [piSettingsExpanded, setPiSettingsExpanded] = useState(false);
	const [systemPromptExpanded, setSystemPromptExpanded] = useState(false);

	const defaultTemplate = config?.worktreeSystemPromptTemplateDefault ?? "";
	const isCustomized = fields.worktreeSystemPromptTemplate !== defaultTemplate;

	const handleResetToDefault = useCallback(() => {
		setField("worktreeSystemPromptTemplate", defaultTemplate);
	}, [setField, defaultTemplate]);

	const ClaudeChevron = claudeSettingsExpanded ? ChevronDown : ChevronRight;
	const CodexChevron = codexSettingsExpanded ? ChevronDown : ChevronRight;
	const PiChevron = piSettingsExpanded ? ChevronDown : ChevronRight;
	const PromptChevron = systemPromptExpanded ? ChevronDown : ChevronRight;
	const claudeSettingsSummary = `New/restarted sessions only · ${CLAUDE_PERMISSION_MODE_LABELS[fields.claudeLaunchPermissionMode]}`;
	const codexSettingsSummary = `New/restarted sessions only · ${CODEX_APPROVALS_REVIEWER_LABELS[fields.codexApprovalsReviewer]}`;
	const piSupportedVersion = config?.agents.find((agent) => agent.id === "pi")?.requiredVersion ?? "1.5.2";
	const piSettingsSummary = `Exactly ${piSupportedVersion} · Native Pi execution`;

	return (
		<section aria-labelledby="settings-agents-heading">
			<h3 id="settings-agents-heading" className="m-0 mb-2 text-base font-semibold text-text-primary">
				Agent launch settings
			</h3>
			<p className="text-text-secondary text-sm leading-6 mt-0 mb-3">
				Quarterdeck checks the <code className="text-sm bg-surface-3 px-1 rounded">PATH</code> inherited from the
				shell that launched it to detect Claude, Codex, and Pi. Choose a harness in the new task dialog; unavailable
				harnesses are shown there with install or upgrade status.
			</p>

			<SettingsSwitch
				checked={fields.lowerAgentProcessPriority}
				onCheckedChange={(v) => setField("lowerAgentProcessPriority", v)}
				disabled={disabled}
				label="Run agents at lower CPU priority"
				description="New/restarted sessions only. Builds and tests that agents start yield CPU to Quarterdeck and your other apps when the machine is busy, and still run at full speed when it is idle. Manual shells are unaffected."
			/>

			<RadixCollapsible.Root
				open={claudeSettingsExpanded}
				onOpenChange={setClaudeSettingsExpanded}
				className="settings-harness-row mt-4"
			>
				<RadixCollapsible.Trigger asChild>
					<button
						type="button"
						className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-surface-2 px-3 py-3 text-left text-sm text-text-primary hover:border-border-bright hover:bg-surface-3 data-[state=open]:rounded-b-none"
					>
						<span className="min-w-0">
							<span className="block font-medium">Claude Code</span>
							<span className="block text-sm leading-6 text-text-secondary">{claudeSettingsSummary}</span>
						</span>
						<ClaudeChevron size={16} className="shrink-0 text-text-secondary" />
					</button>
				</RadixCollapsible.Trigger>
				<RadixCollapsible.Content className="overflow-hidden rounded-b-md border-x border-b border-border bg-surface-1">
					<div className="px-3 py-3">
						<div className="flex flex-wrap items-center justify-between gap-3">
							<label
								htmlFor="runtime-settings-claude-permission-mode"
								className="text-text-primary text-sm font-medium"
							>
								Launch permissions
							</label>
							<select
								id="runtime-settings-claude-permission-mode"
								name="claudeLaunchPermissionMode"
								aria-describedby="runtime-settings-claude-permission-help"
								value={fields.claudeLaunchPermissionMode}
								onChange={(event) =>
									setField(
										"claudeLaunchPermissionMode",
										normalizeClaudeLaunchPermissionMode(event.currentTarget.value),
									)
								}
								disabled={disabled}
								className="h-9 min-w-0 max-w-full rounded-md border border-border bg-surface-2 px-2 text-sm text-text-primary outline-none hover:border-border-bright focus:border-border-focus disabled:opacity-40"
							>
								{Object.entries(CLAUDE_PERMISSION_MODE_LABELS).map(([value, label]) => (
									<option key={value} value={value}>
										{label}
									</option>
								))}
							</select>
						</div>
						<p
							id="runtime-settings-claude-permission-help"
							className="text-text-secondary text-sm leading-6 mt-1 mb-0"
						>
							{fields.claudeLaunchPermissionMode === "inherit"
								? "Uses Claude's configured default mode without a Quarterdeck override."
								: fields.claudeLaunchPermissionMode === "default"
									? "Starts Claude in its standard mode: reads run automatically while edits and shell commands can prompt."
									: fields.claudeLaunchPermissionMode === "acceptEdits"
										? "Automatically accepts edits and common working-directory file operations, while other commands can still prompt."
										: fields.claudeLaunchPermissionMode === "plan"
											? "Starts read-only Plan Mode so Claude explores and proposes changes before editing."
											: fields.claudeLaunchPermissionMode === "auto"
												? "Uses Claude's research-preview safety checks to review actions automatically. Account eligibility and managed policy still apply."
												: fields.claudeLaunchPermissionMode === "dontAsk"
													? "Automatically denies tools that are not already allowed instead of asking interactively."
													: "Skips Claude permission prompts and most safety checks. Use only in an externally isolated environment; managed policy can disable this mode."}
						</p>
					</div>
				</RadixCollapsible.Content>
			</RadixCollapsible.Root>

			<RadixCollapsible.Root
				open={codexSettingsExpanded}
				onOpenChange={setCodexSettingsExpanded}
				className="settings-harness-row mt-4"
			>
				<RadixCollapsible.Trigger asChild>
					<button
						type="button"
						className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-surface-2 px-3 py-3 text-left text-sm text-text-primary hover:border-border-bright hover:bg-surface-3 data-[state=open]:rounded-b-none"
					>
						<span className="min-w-0">
							<span className="block font-medium">Codex</span>
							<span className="block text-sm leading-6 text-text-secondary">{codexSettingsSummary}</span>
						</span>
						<CodexChevron size={16} className="shrink-0 text-text-secondary" />
					</button>
				</RadixCollapsible.Trigger>
				<RadixCollapsible.Content className="overflow-hidden rounded-b-md border-x border-b border-border bg-surface-1">
					<div className="px-3 py-3">
						<div className="flex flex-wrap items-center justify-between gap-3">
							<label
								htmlFor="runtime-settings-codex-approvals-reviewer"
								className="text-text-primary text-sm font-medium"
							>
								Launch permissions
							</label>
							<select
								id="runtime-settings-codex-approvals-reviewer"
								name="codexApprovalsReviewer"
								aria-describedby="runtime-settings-codex-permission-help"
								value={fields.codexApprovalsReviewer}
								onChange={(event) =>
									setField(
										"codexApprovalsReviewer",
										normalizeCodexApprovalsReviewer(event.currentTarget.value),
									)
								}
								disabled={disabled}
								className="h-9 min-w-0 max-w-full rounded-md border border-border bg-surface-2 px-2 text-sm text-text-primary outline-none hover:border-border-bright focus:border-border-focus disabled:opacity-40"
							>
								<option value="inherit">Inherit Codex config</option>
								<option value="user">Ask me</option>
								<option value="auto_review">Approve for me</option>
								<option value="dangerously_bypass">Dangerously bypass approvals and sandbox</option>
							</select>
						</div>
						<p
							id="runtime-settings-codex-permission-help"
							className="text-text-secondary text-sm leading-6 mt-1 mb-0"
						>
							{fields.codexApprovalsReviewer === "inherit"
								? "Uses the reviewer selected by Codex configuration without a Quarterdeck override."
								: fields.codexApprovalsReviewer === "user"
									? "Forces eligible approval requests to pause for you in new or restarted Codex sessions."
									: fields.codexApprovalsReviewer === "auto_review"
										? "Launches new or restarted Codex sessions with --approve-for-me, routing eligible requests through automatic review while keeping the workspace-write sandbox."
										: "Launches new or restarted Codex sessions with --dangerously-bypass-approvals-and-sandbox. Commands run without confirmation prompts or Codex sandboxing; use only in an externally sandboxed environment."}
						</p>
					</div>
				</RadixCollapsible.Content>
			</RadixCollapsible.Root>

			<RadixCollapsible.Root
				open={piSettingsExpanded}
				onOpenChange={setPiSettingsExpanded}
				className="settings-harness-row mt-4"
			>
				<RadixCollapsible.Trigger asChild>
					<button
						type="button"
						className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-surface-2 px-3 py-3 text-left text-sm text-text-primary hover:border-border-bright hover:bg-surface-3 data-[state=open]:rounded-b-none"
					>
						<span className="min-w-0">
							<span className="block font-medium">Pi</span>
							<span className="block text-sm leading-6 text-text-secondary">{piSettingsSummary}</span>
						</span>
						<PiChevron size={16} className="shrink-0 text-text-secondary" />
					</button>
				</RadixCollapsible.Trigger>
				<RadixCollapsible.Content className="overflow-hidden rounded-b-md border-x border-b border-border bg-surface-1">
					<div className="space-y-4 px-3 py-3 text-sm leading-6 text-text-secondary">
						<p className="m-0">
							Quarterdeck supports exactly Pi {piSupportedVersion}. Newer Pi releases remain unavailable until
							the lifecycle and resume contract is validated and Quarterdeck moves this version deliberately.
						</p>
						<p className="m-0">
							Pi runs with its native tool and extension behavior. Quarterdeck adds no approval prompts or
							sandbox.
						</p>
					</div>
				</RadixCollapsible.Content>
			</RadixCollapsible.Root>

			<RadixCollapsible.Root
				open={systemPromptExpanded}
				onOpenChange={setSystemPromptExpanded}
				className="settings-harness-row mt-6 border-t border-border pt-6"
			>
				<RadixCollapsible.Trigger asChild>
					<button
						type="button"
						className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-surface-2 px-3 py-3 text-left text-sm text-text-primary hover:border-border-bright hover:bg-surface-3"
					>
						<span className="min-w-0">
							<span className="block font-medium">Worktree context prompt</span>
							<span className="block text-sm leading-6 text-text-secondary">
								{isCustomized ? "Custom launch context template" : "Default launch context template"}
							</span>
						</span>
						<PromptChevron size={16} className="shrink-0 text-text-secondary" />
					</button>
				</RadixCollapsible.Trigger>
				<RadixCollapsible.Content className="mt-2">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<p className="text-text-secondary text-sm leading-6 my-0">
							Sent to worktree-launched harnesses as Claude system-prompt context or Codex developer
							instructions.
						</p>
						{isCustomized ? (
							<button
								type="button"
								onClick={handleResetToDefault}
								disabled={disabled}
								className="shrink-0 text-sm text-accent hover:text-accent-hover bg-transparent border-none p-0 cursor-pointer disabled:opacity-40"
							>
								Use default template
							</button>
						) : null}
					</div>
					<p
						id="runtime-settings-worktree-system-prompt-help"
						className="text-text-secondary text-sm leading-6 mt-1 mb-2"
					>
						Use default template only changes this draft. It takes effect when you choose Save changes. Supports{" "}
						<code className="text-sm bg-surface-3 px-1 rounded">{"{{cwd}}"}</code>,{" "}
						<code className="text-sm bg-surface-3 px-1 rounded">{"{{project_path}}"}</code>, and{" "}
						<code className="text-sm bg-surface-3 px-1 rounded">{"{{detached_head_note}}"}</code> placeholders.
					</p>
					<textarea
						id="runtime-settings-worktree-system-prompt"
						aria-label="Worktree context prompt template"
						aria-describedby="runtime-settings-worktree-system-prompt-help"
						value={fields.worktreeSystemPromptTemplate}
						onChange={(e) => setField("worktreeSystemPromptTemplate", e.target.value)}
						disabled={disabled}
						rows={8}
						className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text-primary font-mono leading-relaxed resize-y focus:border-border-focus focus:outline-none disabled:opacity-40"
						placeholder="System prompt template for worktree harnesses..."
					/>
				</RadixCollapsible.Content>
			</RadixCollapsible.Root>
		</section>
	);
}
