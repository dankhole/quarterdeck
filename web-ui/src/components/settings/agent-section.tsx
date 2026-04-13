// Settings section: agent selection and autonomous mode toggle.
import { getRuntimeAgentCatalogEntry } from "@runtime-agent-catalog";
import { Circle, CircleDot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { SettingsCheckbox } from "@/components/ui/settings-controls";
import type { RuntimeAgentId } from "@/runtime/types";
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
}: SettingsSectionProps & {
	agents: AgentRowModel[];
	configLoaded: boolean;
}): React.ReactElement {
	const bypassPermissionsCheckboxId = "runtime-settings-bypass-permissions";

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
		</>
	);
}
