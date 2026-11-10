// Settings sections: AI Features, Notifications, and Terminal.
import { Sparkles, Volume2 } from "lucide-react";
import { showAppToast } from "@/components/app-toaster";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { NumericSettingsInput, SettingsCheckbox, SettingsSwitch } from "@/components/ui/settings-controls";
import { resetAllTerminalRenderers } from "@/terminal/terminal-pool";
import { notificationAudioPlayer } from "@/utils/notification-audio";
import type { SettingsSectionProps } from "./settings-section-props";

export function AiFeaturesSection({ llmConfigured }: { llmConfigured: boolean }): React.ReactElement {
	return (
		<section aria-labelledby="settings-ai-heading" className="mt-6 space-y-2 border-t border-border pt-6">
			<h3 id="settings-ai-heading" className="m-0 flex items-center gap-2 text-base font-semibold text-text-primary">
				<Sparkles size={16} />
				AI features
			</h3>
			{!llmConfigured ? (
				<div className="rounded-md border border-border bg-surface-2 p-3 text-sm leading-6 text-text-secondary break-words">
					AI text generation tries your saved Codex/ChatGPT login first, then your saved Claude Code login. To
					configure an optional fallback gateway, set <code>QUARTERDECK_LLM_BASE_URL</code> and{" "}
					<code>QUARTERDECK_LLM_API_KEY</code>, and explicitly choose <code>QUARTERDECK_LLM_MODEL</code>. An
					existing team gateway, local{" "}
					<a
						href="https://docs.litellm.ai/"
						target="_blank"
						rel="noreferrer"
						className="text-accent hover:underline"
					>
						LiteLLM proxy
					</a>
					, or another OpenAI-compatible endpoint works. Restart Quarterdeck after changing its environment.
				</div>
			) : (
				<p className="m-0 text-sm leading-6 text-text-secondary">
					Titles, branch names, and commit messages try your saved Codex/ChatGPT login first, then your saved
					Claude Code login, then the configured gateway. Explicit task-title provider overrides still apply.
				</p>
			)}
		</section>
	);
}

const NOTIFICATION_EVENTS = [
	["permission", "Permissions", "Task is waiting for approval"],
	["review", "Review", "Task finished or needs attention"],
	["failure", "Failure", "Harness session failed or errored"],
] as const;

export function NotificationsSection({ fields, setField, disabled }: SettingsSectionProps): React.ReactElement {
	const masterOff = !fields.audibleNotificationsEnabled || disabled;

	return (
		<section aria-labelledby="settings-notifications-heading" className="space-y-4">
			<h3 id="settings-notifications-heading" className="m-0 text-base font-semibold text-text-primary">
				Notification sounds
			</h3>
			<SettingsSwitch
				checked={fields.audibleNotificationsEnabled}
				onCheckedChange={(v) => setField("audibleNotificationsEnabled", v)}
				disabled={disabled}
				label="Play sounds when tasks need attention"
			/>
			<div className={cn("settings-row flex items-start gap-3 text-sm leading-6", masterOff && "opacity-40")}>
				<SettingsCheckbox
					id="audible-notification-only-when-hidden"
					checked={fields.audibleNotificationsOnlyWhenHidden}
					onCheckedChange={(v) => setField("audibleNotificationsOnlyWhenHidden", v)}
					disabled={masterOff}
					className="mt-1"
				/>
				<label htmlFor="audible-notification-only-when-hidden" className="cursor-pointer">
					<span className="block font-medium text-text-primary">Only when tab is hidden</span>
					<span className="block text-text-secondary">Skip sounds while you're looking at the board.</span>
				</label>
			</div>
			<div className="settings-row">
				<label htmlFor="audible-notification-volume" className="block mb-2 text-sm font-medium text-text-primary">
					Sound volume
				</label>
				<div className="flex items-center gap-3">
					<Volume2 size={16} className={cn("shrink-0 text-text-secondary", masterOff && "opacity-40")} />
					<input
						id="audible-notification-volume"
						name="audible-notification-volume"
						type="range"
						min={0}
						max={100}
						step={1}
						value={Math.round(fields.audibleNotificationVolume * 100)}
						onChange={(e) => setField("audibleNotificationVolume", Number(e.target.value) / 100)}
						disabled={masterOff}
						className="min-w-0 flex-1 h-1.5 accent-accent disabled:opacity-40"
					/>
					<span
						className={cn("text-sm text-text-secondary w-10 text-right tabular-nums", masterOff && "opacity-40")}
					>
						{Math.round(fields.audibleNotificationVolume * 100)}%
					</span>
				</div>
			</div>
			<fieldset className={cn("m-0 min-w-0 border-0 border-t border-border p-0 pt-4", masterOff && "opacity-40")}>
				<legend className="text-sm font-medium text-text-primary pr-2">Sounds by event</legend>
				<div className="grid grid-cols-[auto_minmax(0,7rem)_minmax(0,1fr)] gap-x-3 gap-y-4 items-start text-sm leading-6">
					<span className="font-medium text-text-secondary">Enabled</span>
					<span className="text-center font-medium text-text-secondary">Mute while viewing project</span>
					<span className="font-medium text-text-secondary">Event</span>
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
			</fieldset>
			<div className="border-t border-border pt-4">
				<Button
					size="sm"
					disabled={masterOff}
					onClick={() => {
						notificationAudioPlayer.ensureContext();
						void notificationAudioPlayer
							.play("permission", fields.audibleNotificationVolume)
							.then((outcome) => {
								if (outcome === "simulated") {
									showAppToast({
										intent: "success",
										message: "Agent Lab simulated the notification sound; no audio was played.",
									});
								}
							})
							.catch((error: unknown) => {
								showAppToast({
									intent: "danger",
									message: `Could not record the simulated notification sound: ${error instanceof Error ? error.message : String(error)}`,
								});
							});
					}}
				>
					Test sound now
				</Button>
				<p className="mt-2 mb-0 text-sm leading-6 text-text-secondary">
					Play a preview immediately at the selected volume, without saving changes.
				</p>
			</div>
		</section>
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
				className="mt-1"
			/>
			<div className="flex justify-center pt-1">
				<SettingsCheckbox
					id={`audible-notification-suppress-${eventKey}`}
					checked={suppressCurrentProject}
					onCheckedChange={onSuppressChange}
					disabled={rowOff}
				/>
				<label className="sr-only" htmlFor={`audible-notification-suppress-${eventKey}`}>
					Mute {label.toLowerCase()} sounds while viewing the project
				</label>
			</div>
			<label htmlFor={`audible-notification-${eventKey}`} className={cn("cursor-pointer", rowOff && "opacity-40")}>
				<span className="block font-medium text-text-primary">{label}</span>
				<span className="block text-text-secondary">{description}</span>
			</label>
		</>
	);
}

export function TerminalSection({ fields, setField, disabled }: SettingsSectionProps): React.ReactElement {
	return (
		<section aria-labelledby="settings-terminal-heading" className="space-y-4">
			<h3 id="settings-terminal-heading" className="m-0 text-base font-semibold text-text-primary">
				Terminal
			</h3>
			<SettingsSwitch
				checked={fields.shellAutoRestartEnabled}
				onCheckedChange={(v) => setField("shellAutoRestartEnabled", v)}
				disabled={disabled}
				label="Auto-restart shell terminals on unexpected exit"
				description="When enabled, shell terminals that crash or exit unexpectedly will automatically restart."
			/>
			<div className="settings-row">
				<NumericSettingsInput
					id="terminal-font-weight"
					label="Font weight"
					value={fields.terminalFontWeight}
					onChange={(v) => setField("terminalFontWeight", v)}
					disabled={disabled}
					min={100}
					max={900}
				/>
				<p className="text-text-secondary text-sm leading-6 mt-1 mb-0">
					CSS font weight for terminal text. Lower values are thinner. Typical range: 300–400.
				</p>
			</div>
			<div className="border-t border-border pt-4">
				<Button
					size="sm"
					onClick={() => {
						resetAllTerminalRenderers();
						showAppToast({
							intent: "success",
							message: "Terminal renderers reset",
							timeout: 3000,
						});
					}}
				>
					Reset window terminal rendering now
				</Button>
				<p className="text-text-secondary text-sm leading-6 mt-2 mb-0">
					Immediately clear cached font textures and re-render all terminals in this window. Use this if terminal
					text looks blurry or distorted after moving between monitors. Other windows and running agents are
					unchanged. This does not save form changes.
				</p>
			</div>
		</section>
	);
}
