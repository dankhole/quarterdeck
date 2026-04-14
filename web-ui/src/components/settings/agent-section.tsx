// Settings section: agent selection, autonomous mode, and worktree system prompt.
import { getRuntimeAgentCatalogEntry } from "@runtime-agent-catalog";
import { Circle, CircleDot } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { SettingsCheckbox } from "@/components/ui/settings-controls";
import type { RuntimeAgentId, RuntimeConfigResponse } from "@/runtime/types";
import type { SettingsSectionProps } from "./settings-section-props";

export interface AgentRowModel {
	id: RuntimeAgentId;
	label: string;
	binary: string;
	command: string;
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
	const isInstalled = agent.installed === true;
	const isInstallStatusPending = agent.installed === null;

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
			className="flex items-center justify-between gap-3 py-1.5"
			style={{ cursor: isInstalled ? "pointer" : "default" }}
		>
			<div className="flex items-start gap-2 min-w-0">
				{isSelected ? (
					<CircleDot size={16} className="text-accent mt-0.5 shrink-0" />
				) : (
					<Circle
						size={16}
						className={cn("mt-0.5 shrink-0", !isInstalled ? "text-text-tertiary" : "text-text-secondary")}
					/>
				)}
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<span className="text-[13px] text-text-primary">{agent.label}</span>
						{isInstalled ? (
							<span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-status-green/10 text-status-green">
								Installed
							</span>
						) : isInstallStatusPending ? (
							<span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-surface-3 text-text-secondary">
								Checking...
							</span>
						) : null}
					</div>
					{agent.command ? (
						<p className="text-text-secondary font-mono text-xs mt-0.5 m-0">{agent.command}</p>
					) : null}
				</div>
			</div>
			{agent.installed === false && installUrl ? (
				<a
					href={installUrl}
					target="_blank"
					rel="noreferrer"
					onClick={(event: React.MouseEvent) => event.stopPropagation()}
					className="inline-flex items-center justify-center rounded-md font-medium duration-150 cursor-default select-none h-7 px-2 text-xs bg-surface-2 border border-border text-text-primary hover:bg-surface-3 hover:border-border-bright"
				>
					Install
				</a>
			) : agent.installed === false ? (
				<Button size="sm" disabled>
					Install
				</Button>
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
	const bypassPermissionsCheckboxId = "runtime-settings-bypass-permissions";
	const [systemPromptExpanded, setSystemPromptExpanded] = useState(false);

	const defaultTemplate = config?.worktreeSystemPromptTemplateDefault ?? "";
	const isCustomized = fields.worktreeSystemPromptTemplate !== defaultTemplate;

	const handleResetToDefault = useCallback(() => {
		setField("worktreeSystemPromptTemplate", defaultTemplate);
	}, [setField, defaultTemplate]);

	return (
		<>
			<h6 className="font-semibold text-text-primary mt-3 mb-0">Agent</h6>
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
			) : null}
			<label
				htmlFor={bypassPermissionsCheckboxId}
				className="flex items-center gap-2 text-[13px] text-text-primary mt-2 cursor-pointer"
			>
				<SettingsCheckbox
					id={bypassPermissionsCheckboxId}
					checked={fields.agentAutonomousModeEnabled}
					onCheckedChange={(v) => setField("agentAutonomousModeEnabled", v)}
					disabled={disabled}
				/>
				<span>Enable bypass permissions flag</span>
			</label>
			<p className="text-text-secondary text-[13px] ml-6 mt-0 mb-0">
				Allows agents to use tools without stopping for permission. Use at your own risk.
			</p>

			<div className="mt-3">
				<div className="flex items-center justify-between">
					<button
						type="button"
						onClick={() => setSystemPromptExpanded((v) => !v)}
						className="text-[13px] text-text-primary font-medium cursor-pointer bg-transparent border-none p-0 hover:text-accent"
					>
						{systemPromptExpanded ? "▾" : "▸"} Worktree system prompt
						{isCustomized ? (
							<span className="ml-1.5 text-[11px] text-status-blue font-normal">(customized)</span>
						) : null}
					</button>
					{systemPromptExpanded && isCustomized ? (
						<button
							type="button"
							onClick={handleResetToDefault}
							disabled={disabled}
							className="text-[12px] text-accent hover:text-accent-hover bg-transparent border-none p-0 cursor-pointer disabled:opacity-40"
						>
							Reset to default
						</button>
					) : null}
				</div>
				{systemPromptExpanded ? (
					<>
						<p className="text-text-secondary text-[13px] mt-1 mb-2">
							Appended to the agent's system prompt when running in a worktree. Supports{" "}
							<code className="text-[12px] bg-surface-3 px-1 rounded">{"{{cwd}}"}</code>,{" "}
							<code className="text-[12px] bg-surface-3 px-1 rounded">{"{{workspace_path}}"}</code>, and{" "}
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
					</>
				) : null}
			</div>
		</>
	);
}
