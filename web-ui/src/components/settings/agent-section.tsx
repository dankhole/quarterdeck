// Settings section: agent selection and worktree system prompt.
import * as RadixCollapsible from "@radix-ui/react-collapsible";
import { getRuntimeAgentCatalogEntry } from "@runtime-agent-catalog";
import { ChevronDown, ChevronRight, Circle, CircleDot } from "lucide-react";
import { useCallback, useState } from "react";
import { cn } from "@/components/ui/cn";
import { NumericSettingsInput } from "@/components/ui/settings-controls";
import type { RuntimeAgentDefinition, RuntimeAgentId, RuntimeConfigResponse } from "@/runtime/types";
import type { SettingsSectionProps } from "./settings-section-props";

export interface AgentRowModel {
	id: RuntimeAgentId;
	label: string;
	binary: string;
	command: string;
	status: RuntimeAgentDefinition["status"];
	statusMessage: string | null;
	installed: boolean | null;
}

function AgentRow({
	agent,
	isSelected,
	onSelect,
	disabled,
}: {
	agent: AgentRowModel;
	isSelected: boolean;
	onSelect: () => void;
	disabled: boolean;
}): React.ReactElement {
	const installUrl = getRuntimeAgentCatalogEntry(agent.id)?.installUrl;
	const isInstalled = agent.status === "installed";
	const requiresUpgrade = agent.status === "upgrade_required";
	const isInstallStatusPending = agent.installed === null;
	const isPiAgent = agent.id === "pi";

	return (
		<div
			role="button"
			tabIndex={0}
			onClick={() => {
				if (isInstalled && !disabled) {
					onSelect();
				}
			}}
			onKeyDown={(event) => {
				if (event.key === "Enter" && isInstalled && !disabled) {
					onSelect();
				}
			}}
			className="flex items-start justify-between gap-3 py-1.5"
			style={{ cursor: isInstalled ? "pointer" : "default" }}
		>
			<div className="flex min-w-0 flex-1 items-start gap-2">
				{isSelected ? (
					<CircleDot size={16} className="text-accent mt-0.5 shrink-0" />
				) : (
					<Circle
						size={16}
						className={cn("mt-0.5 shrink-0", !isInstalled ? "text-text-tertiary" : "text-text-secondary")}
					/>
				)}
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-[13px] text-text-primary">{agent.label}</span>
						{isPiAgent ? (
							<span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-status-orange/10 text-status-orange">
								Experimental
							</span>
						) : null}
						{isInstalled ? (
							<span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-status-green/10 text-status-green">
								Installed
							</span>
						) : requiresUpgrade ? (
							<span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-status-orange/10 text-status-orange">
								Upgrade required
							</span>
						) : isInstallStatusPending ? (
							<span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-surface-3 text-text-secondary">
								Checking...
							</span>
						) : null}
					</div>
					{agent.command ? (
						<p className="text-text-secondary font-mono text-xs mt-0.5 m-0 break-all">{agent.command}</p>
					) : null}
					{isPiAgent ? (
						<p className="text-status-orange text-xs mt-1 mb-0 break-words">
							Pi support is experimental and unstable; expect rough edges during task sessions.
						</p>
					) : null}
					{agent.statusMessage ? (
						<p className="text-status-orange text-xs mt-1 mb-0 break-words">{agent.statusMessage}</p>
					) : null}
				</div>
			</div>
			{agent.installed === false && installUrl ? (
				<a
					href={installUrl}
					target="_blank"
					rel="noreferrer"
					onClick={(event: React.MouseEvent) => event.stopPropagation()}
					className="inline-flex h-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 px-2 text-xs font-medium text-text-primary duration-150 cursor-default select-none hover:bg-surface-3 hover:border-border-bright"
				>
					{requiresUpgrade ? "Upgrade" : "Install"}
				</a>
			) : null}
		</div>
	);
}

export function AgentSection({
	fields,
	setField,
	disabled,
	agents,
	configLoaded,
	config,
}: SettingsSectionProps & {
	agents: AgentRowModel[];
	configLoaded: boolean;
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
			<h6 className="font-semibold text-text-primary mt-3 mb-1">Task Agent</h6>
			{agents.map((agent) => (
				<AgentRow
					key={agent.id}
					agent={agent}
					isSelected={agent.id === fields.selectedAgentId}
					onSelect={() => setField("selectedAgentId", agent.id)}
					disabled={disabled}
				/>
			))}
			{!configLoaded ? (
				<p className="text-text-secondary py-2">Checking which CLIs are installed for this project...</p>
			) : (
				<p className="text-text-secondary text-[12px] mt-2 mb-0">
					Detection checks whether each CLI is available on Quarterdeck&apos;s PATH. Codex and Pi also enforce
					minimum supported versions; Codex verifies native hook support and enables <code>codex_hooks</code> at
					launch.
				</p>
			)}

			<h6 className="font-semibold text-text-primary mt-4 mb-2">Agent Launch</h6>
			<NumericSettingsInput
				id="agent-terminal-row-multiplier"
				label="Claude row multiplier"
				value={fields.agentTerminalRowMultiplier}
				onChange={(v) => setField("agentTerminalRowMultiplier", v)}
				disabled={disabled}
				min={1}
				max={20}
			/>
			<p className="text-text-secondary text-[13px] mt-1 mb-3">
				Makes Claude Code output more content before pausing, so you can scroll back and see more of what it did.
				Codex ignores this setting. Set to 1 if Claude's UI looks broken. Applies to new Claude sessions only.
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
							Sent to worktree-launched agents as Claude system-prompt context or Codex developer instructions.
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
						placeholder="System prompt template for worktree agents..."
					/>
				</RadixCollapsible.Content>
			</RadixCollapsible.Root>
		</>
	);
}
