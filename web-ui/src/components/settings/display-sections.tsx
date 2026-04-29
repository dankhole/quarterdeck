// Settings sections: AI Features, Notifications, and Terminal.
import { Sparkles, Volume2 } from "lucide-react";
import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { NumericSettingsInput, SettingsCheckbox, SettingsSwitch } from "@/components/ui/settings-controls";
import { resetAllTerminalRenderers } from "@/terminal/terminal-pool";
import { notificationAudioPlayer } from "@/utils/notification-audio";
import type { SettingsSectionProps } from "./settings-section-props";

// ---------------------------------------------------------------------------
// AI Features
// ---------------------------------------------------------------------------

export function AiFeaturesSection({
	fields,
	setField,
	disabled,
	llmConfigured,
}: SettingsSectionProps & { llmConfigured: boolean }): React.ReactElement {
	return (
		<>
			<h6 className="font-semibold text-text-primary mt-4 mb-1 flex items-center gap-1.5">
				<Sparkles size={14} />
				AI Features
			</h6>
			{!llmConfigured ? (
				<div className="rounded-md border border-status-orange/30 bg-status-orange/5 px-3 py-2 text-[13px] text-status-orange mb-2">
					LLM helpers are unavailable. Set <code className="text-[12px]">QUARTERDECK_LLM_BASE_URL</code> and{" "}
					<code className="text-[12px]">QUARTERDECK_LLM_API_KEY</code> plus{" "}
					<code className="text-[12px]">QUARTERDECK_LLM_MODEL</code> in the shell that launches Quarterdeck.
				</div>
			) : (
				<p className="text-text-secondary text-[13px] mt-0 mb-2">
					Titles, branch names, commit messages, and optional summary polish use the configured lightweight LLM
					helper.
				</p>
			)}

			<label
				htmlFor="runtime-settings-show-summary-on-cards"
				className="flex items-center gap-2 text-[13px] text-text-primary cursor-pointer"
			>
				<SettingsCheckbox
					id="runtime-settings-show-summary-on-cards"
					checked={fields.showSummaryOnCards}
					onCheckedChange={(v) => setField("showSummaryOnCards", v)}
					disabled={disabled}
				/>
				<span>Show conversation summary on cards</span>
			</label>
			<p className="text-text-secondary text-[13px] ml-6 mt-0 mb-0">
				Display a truncated preview of the task's latest summary below the title.
			</p>

			<label
				htmlFor="runtime-settings-llm-summary-polish"
				className="flex items-center gap-2 text-[13px] text-text-primary mt-2 cursor-pointer"
			>
				<SettingsCheckbox
					id="runtime-settings-llm-summary-polish"
					checked={fields.llmSummaryPolishEnabled}
					onCheckedChange={(v) => setField("llmSummaryPolishEnabled", v)}
					disabled={disabled}
				/>
				<span>Polish summaries with LLM</span>
			</label>
			<p className="text-text-secondary text-[13px] ml-6 mt-0 mb-0">
				When enabled, task state changes can trigger background summary polish. Use a cheap, fast configured model
				such as Haiku because tasks can bounce between in-progress and review.
			</p>
		</>
	);
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

const NOTIFICATION_EVENTS = [
	["permission", "Permissions", "Task is waiting for approval"],
	["review", "Review", "Task finished or needs attention"],
	["failure", "Failure", "Harness session failed or errored"],
] as const;

export function NotificationsSection({ fields, setField, disabled }: SettingsSectionProps): React.ReactElement {
	const masterOff = !fields.audibleNotificationsEnabled || disabled;

	return (
		<>
			<h6 className="font-semibold text-text-primary mt-4 mb-2">Notifications</h6>
			<SettingsSwitch
				checked={fields.audibleNotificationsEnabled}
				onCheckedChange={(v) => setField("audibleNotificationsEnabled", v)}
				disabled={disabled}
				label="Play sounds when tasks need attention"
			/>
			<div className={cn("flex items-center gap-2 mt-2 text-[13px]", masterOff && "opacity-40")}>
				<SettingsCheckbox
					id="audible-notification-only-when-hidden"
					checked={fields.audibleNotificationsOnlyWhenHidden}
					onCheckedChange={(v) => setField("audibleNotificationsOnlyWhenHidden", v)}
					disabled={masterOff}
				/>
				<label htmlFor="audible-notification-only-when-hidden" className="cursor-pointer">
					<span className="text-text-primary">Only when tab is hidden</span>
					<span className="text-text-tertiary"> — skip sounds while you're looking at the board</span>
				</label>
			</div>
			<div className="flex items-center gap-3 mt-3">
				<Volume2 size={14} className={cn("text-text-secondary", masterOff && "opacity-40")} />
				<input
					name="audible-notification-volume"
					type="range"
					min={0}
					max={100}
					step={1}
					value={Math.round(fields.audibleNotificationVolume * 100)}
					onChange={(e) => setField("audibleNotificationVolume", Number(e.target.value) / 100)}
					disabled={masterOff}
					className="flex-1 h-1.5 accent-accent disabled:opacity-40"
				/>
				<span
					className={cn("text-[13px] text-text-secondary w-8 text-right tabular-nums", masterOff && "opacity-40")}
				>
					{Math.round(fields.audibleNotificationVolume * 100)}%
				</span>
			</div>
			{/* Per-event grid: Enabled | Mute project viewed | Event label */}
			<div className={cn("mt-3", masterOff && "opacity-40")}>
				<div className="grid grid-cols-[auto_auto_1fr] gap-x-4 gap-y-2 items-center text-[13px]">
					{/* Header row */}
					<span className="text-text-tertiary text-[12px] font-medium">Enabled</span>
					<span className="text-text-tertiary text-[12px] font-medium">Mute project viewed</span>
					<span />
					{/* Event rows */}
					{NOTIFICATION_EVENTS.map(([key, label, description]) => (
						<NotificationEventRow
							key={key}
							eventKey={key}
							label={label}
							description={description}
							enabled={fields.audibleNotificationEvents[key]}
							suppressCurrentProject={fields.audibleNotificationSuppressCurrentProject[key]}
							onEnabledChange={(v) =>
								setField("audibleNotificationEvents", {
									...fields.audibleNotificationEvents,
									[key]: v,
								})
							}
							onSuppressChange={(v) =>
								setField("audibleNotificationSuppressCurrentProject", {
									...fields.audibleNotificationSuppressCurrentProject,
									[key]: v,
								})
							}
							disabled={masterOff}
						/>
					))}
				</div>
			</div>
			<div className="mt-3">
				<Button
					size="sm"
					disabled={masterOff}
					onClick={() => {
						notificationAudioPlayer.ensureContext();
						notificationAudioPlayer.play("permission", fields.audibleNotificationVolume);
					}}
				>
					Test sound
				</Button>
			</div>
		</>
	);
}

function NotificationEventRow({
	eventKey,
	label,
	description,
	enabled,
	suppressCurrentProject,
	onEnabledChange,
	onSuppressChange,
	disabled,
}: {
	eventKey: string;
	label: string;
	description: string;
	enabled: boolean;
	suppressCurrentProject: boolean;
	onEnabledChange: (v: boolean) => void;
	onSuppressChange: (v: boolean) => void;
	disabled: boolean;
}): React.ReactElement {
	const rowOff = disabled || !enabled;
	return (
		<>
			<SettingsCheckbox
				id={`audible-notification-${eventKey}`}
				checked={enabled}
				onCheckedChange={onEnabledChange}
				disabled={disabled}
			/>
			<div className="flex justify-center">
				<SettingsCheckbox
					id={`audible-notification-suppress-${eventKey}`}
					checked={suppressCurrentProject}
					onCheckedChange={onSuppressChange}
					disabled={rowOff}
				/>
			</div>
			<label
				htmlFor={`audible-notification-${eventKey}`}
				className={cn("flex items-center gap-1 cursor-pointer", rowOff && "opacity-40")}
			>
				<span className="text-text-primary">{label}</span>
				<span className="text-text-tertiary">— {description}</span>
			</label>
		</>
	);
}

export function TerminalSection({ fields, setField, disabled }: SettingsSectionProps): React.ReactElement {
	return (
		<>
			<h6 className="font-semibold text-text-primary mt-4 mb-2">Terminal</h6>
			<SettingsSwitch
				checked={fields.shellAutoRestartEnabled}
				onCheckedChange={(v) => setField("shellAutoRestartEnabled", v)}
				disabled={disabled}
				label="Auto-restart shell terminals on unexpected exit"
				description="When enabled, shell terminals that crash or exit unexpectedly will automatically restart."
			/>
			<NumericSettingsInput
				id="terminal-font-weight"
				label="Font weight"
				value={fields.terminalFontWeight}
				onChange={(v) => setField("terminalFontWeight", v)}
				disabled={disabled}
				min={100}
				max={900}
			/>
			<p className="text-text-secondary text-[13px] mt-1 mb-0">
				CSS font weight for terminal text. Lower values are thinner. Typical range: 300–400.
			</p>
			<Button
				size="sm"
				className="mt-3"
				onClick={() => {
					resetAllTerminalRenderers();
					showAppToast({
						intent: "success",
						message: "Terminal renderers reset",
						timeout: 3000,
					});
				}}
			>
				Reset terminal rendering
			</Button>
			<p className="text-text-secondary text-[13px] mt-2 mb-0">
				Clear cached font textures and re-render all terminals. Use this if terminal text looks blurry or distorted
				after moving between monitors.
			</p>
		</>
	);
}
