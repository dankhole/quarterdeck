// Settings sections: AI Features, Notifications, and Terminal.
import { Sparkles, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { SettingsCheckbox, SettingsSwitch } from "@/components/ui/settings-controls";
import { resetAllTerminalRenderers, restoreAllTerminals } from "@/terminal/terminal-pool";
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
					LLM features are unavailable. Set <code className="text-[12px]">ANTHROPIC_BEDROCK_BASE_URL</code> and{" "}
					<code className="text-[12px]">ANTHROPIC_AUTH_TOKEN</code> in the shell that launches Quarterdeck to
					enable auto-generated titles, branch names, and summaries.
				</div>
			) : (
				<p className="text-text-secondary text-[13px] mt-0 mb-2">
					Titles, branch names, and summaries are generated via a lightweight LLM call.
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
				Display a truncated preview of the agent's latest summary below the title.
			</p>

			<label
				htmlFor="runtime-settings-auto-generate-summary"
				className="flex items-center gap-2 text-[13px] text-text-primary mt-2 cursor-pointer"
			>
				<SettingsCheckbox
					id="runtime-settings-auto-generate-summary"
					checked={fields.autoGenerateSummary}
					onCheckedChange={(v) => setField("autoGenerateSummary", v)}
					disabled={disabled}
				/>
				<span>Auto-generate summary with LLM</span>
			</label>
			<p className="text-text-secondary text-[13px] ml-6 mt-0 mb-0">
				Uses a fast model to condense agent conversation excerpts into a short summary for card tooltips.
			</p>
			{fields.autoGenerateSummary ? (
				<div className="flex items-center gap-2 ml-6 mt-1.5">
					<label htmlFor="runtime-settings-summary-stale-seconds" className="text-[13px] text-text-secondary">
						Regenerate after
					</label>
					<input
						id="runtime-settings-summary-stale-seconds"
						type="text"
						inputMode="numeric"
						pattern="[0-9]*"
						value={fields.summaryStaleAfterSeconds}
						disabled={disabled}
						onChange={(event) => {
							const raw = event.target.value.replace(/\D/g, "");
							if (raw === "") {
								return;
							}
							const value = Number.parseInt(raw, 10);
							if (Number.isFinite(value)) {
								setField("summaryStaleAfterSeconds", Math.max(5, Math.min(3600, value)));
							}
						}}
						className="w-20 rounded border border-border bg-surface-2 px-2 py-1 text-[13px] text-text-primary disabled:opacity-40"
					/>
					<span className="text-[13px] text-text-secondary">seconds</span>
				</div>
			) : null}
		</>
	);
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

const NOTIFICATION_EVENTS = [
	["permission", "Permissions", "Task is waiting for approval"],
	["review", "Review", "Task finished or needs attention"],
	["failure", "Failure", "Agent session failed or errored"],
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
			{/* Per-event grid: Enabled | Other projects only | Event label */}
			<div className={cn("mt-3", masterOff && "opacity-40")}>
				<div className="grid grid-cols-[auto_auto_1fr] gap-x-4 gap-y-2 items-center text-[13px]">
					{/* Header row */}
					<span className="text-text-tertiary text-[12px] font-medium">Enabled</span>
					<span className="text-text-tertiary text-[12px] font-medium">Mute focused project</span>
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

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

function FontWeightInput({
	value,
	onChange,
	disabled,
}: {
	value: number;
	onChange: (v: number) => void;
	disabled: boolean;
}) {
	const [draft, setDraft] = useState(String(value));
	const inputRef = useRef<HTMLInputElement>(null);

	// Sync draft when value changes externally (e.g. config load)
	useEffect(() => {
		if (document.activeElement !== inputRef.current) {
			setDraft(String(value));
		}
	}, [value]);

	const commit = () => {
		const parsed = Number(draft);
		if (Number.isFinite(parsed) && parsed >= 100 && parsed <= 900) {
			onChange(parsed);
			setDraft(String(parsed));
		} else {
			// Revert to current value on invalid input
			setDraft(String(value));
		}
	};

	return (
		<div className="flex items-center justify-between gap-3 mt-3">
			<label htmlFor="terminal-font-weight" className="text-text-primary text-[13px] shrink-0">
				Font weight
			</label>
			<input
				ref={inputRef}
				id="terminal-font-weight"
				type="text"
				inputMode="numeric"
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						commit();
						inputRef.current?.blur();
					}
				}}
				disabled={disabled}
				className="h-7 w-14 rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary text-right tabular-nums focus:border-border-focus focus:outline-none"
			/>
		</div>
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
			<FontWeightInput
				value={fields.terminalFontWeight}
				onChange={(v) => setField("terminalFontWeight", v)}
				disabled={disabled}
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
			<Button
				size="sm"
				className="mt-3"
				onClick={() => {
					restoreAllTerminals();
					showAppToast({
						intent: "success",
						message: "Restoring terminals from server",
						timeout: 3000,
					});
				}}
			>
				Re-sync terminal content
			</Button>
			<p className="text-text-secondary text-[13px] mt-2 mb-0">
				Fetch a fresh snapshot from the server for all terminals. Use this if terminal content looks wrong or out of
				sync with the agent.
			</p>
		</>
	);
}
