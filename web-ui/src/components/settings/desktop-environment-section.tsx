import { Button } from "@/components/ui/button";
import { SettingsCheckbox } from "@/components/ui/settings-controls";
import { useDesktopEnvironment } from "@/hooks/settings/use-desktop-environment";

const SOURCE_LABELS = {
	inherited: "App launch",
	"login-shell": "Login shell",
	fallback: "App launch (shell import failed)",
	unresolved: "Not resolved yet",
} as const;

const FAILURE_GUIDANCE = {
	unsupported_shell: "Your login shell is unsupported. Disable shell import or use a supported login shell.",
	capture_failed: "Shell import failed. Check your shell startup files for errors or interactive prompts.",
	capture_timeout: "Shell import timed out. Remove interactive prompts or slow commands from shell startup files.",
	capture_output_limit: "The shell returned too much environment data. Check your shell startup files.",
	capture_invalid: "The shell returned an invalid environment. Check your shell startup files.",
} as const;

export function DesktopEnvironmentSection({ open }: { open: boolean }): React.ReactElement | null {
	const { visible, snapshot, busy, error, message, request } = useDesktopEnvironment(open);
	if (!visible) return null;
	const preferences = snapshot?.preferences;
	const disabled = busy || !preferences || snapshot?.ownership === "attached";
	const supportsShellImport = snapshot?.supportsLoginShellImport !== false;
	const unapplied =
		preferences &&
		((supportsShellImport &&
			snapshot.appliedImportLoginShellEnvironment !== preferences.importLoginShellEnvironment) ||
			JSON.stringify(snapshot.appliedDirectories) !== JSON.stringify(preferences.extraExecutableDirectories));

	return (
		<section className="space-y-4 text-sm leading-6" aria-labelledby="desktop-environment-heading">
			<h3 id="desktop-environment-heading" className="m-0 text-base font-semibold text-text-primary">
				Executable discovery
			</h3>
			{snapshot?.ownership === "attached" ? (
				<p className="text-text-secondary">
					This runtime belongs to the CLI. Change its shell environment and restart the owning CLI to apply it.
				</p>
			) : (
				<>
					<div className="settings-row">
						{supportsShellImport && (
							<>
								<div className="flex items-center gap-2">
									<SettingsCheckbox
										id="desktop-import-login-shell"
										checked={preferences?.importLoginShellEnvironment ?? false}
										disabled={disabled}
										onCheckedChange={(enabled) => void request({ kind: "set-login-shell-import", enabled })}
									/>
									<label htmlFor="desktop-import-login-shell" className="font-medium text-text-primary">
										Import login-shell environment (saves immediately)
									</label>
								</div>
								<p className="text-text-secondary mt-1 mb-2">
									Enabled by default so agents receive exported provider settings, including LiteLLM, from your
									shell. Runs shell startup files, which may request Keychain access. Disable it to
									troubleshoot startup.
								</p>
							</>
						)}
						<p className="text-text-secondary mt-4 mb-0">
							Environment changes save immediately, separately from Save changes. Cancel will not undo them.
							Refresh environment now or restart Quarterdeck to apply them. Refresh protects unsaved work and
							confirms live sessions.
						</p>
						{snapshot ? (
							<p className="text-text-secondary my-2">
								Current source: {SOURCE_LABELS[snapshot.source]}.
								{unapplied ? " Saved changes have not been applied." : ""}
							</p>
						) : null}
						{snapshot?.failureReason ? (
							<p role="status" className="text-status-orange my-2">
								{FAILURE_GUIDANCE[snapshot.failureReason]}
							</p>
						) : null}
					</div>
					<div className="mt-6 border-t border-border pt-6">
						<h3 className="mt-0 mb-2 text-base font-semibold text-text-primary">Extra executable folders</h3>
						<p className="mt-0 mb-4 text-text-secondary">
							Add or reset folders to save this desktop's executable search paths immediately. Apply saved
							changes with Refresh environment now.
						</p>
						{preferences ? (
							<>
								{preferences.extraExecutableDirectories.length ? (
									<ul className="list-disc pl-5 text-text-secondary font-mono text-sm leading-6 break-all">
										{preferences.extraExecutableDirectories.map((directory) => (
											<li key={directory}>{directory}</li>
										))}
									</ul>
								) : (
									<p className="text-text-secondary my-1">
										None. Installed executable folders are discovered automatically.
									</p>
								)}
							</>
						) : null}
						<div className="flex flex-wrap gap-2 mt-2">
							<Button size="sm" disabled={disabled} onClick={() => void request({ kind: "add-folders" })}>
								Add folders…
							</Button>
							<Button
								size="sm"
								disabled={disabled || !preferences?.extraExecutableDirectories.length}
								onClick={() => void request({ kind: "reset-folders" })}
							>
								Reset folders now
							</Button>
							<Button size="sm" disabled={busy || !snapshot} onClick={() => void request({ kind: "refresh" })}>
								Refresh environment now
							</Button>
						</div>
					</div>
					{snapshot && !preferences ? (
						<div className="mt-6 border-t border-border pt-6">
							<p className="mt-0 text-status-orange">
								Saved environment settings could not be read. Reset clears saved folders and disables shell
								import.
							</p>
							<Button size="sm" disabled={busy} onClick={() => void request({ kind: "reset-preferences" })}>
								Reset environment settings now
							</Button>
						</div>
					) : null}
				</>
			)}
			{busy ? (
				<p role="status" className="text-text-secondary mt-2">
					Updating environment settings…
				</p>
			) : null}
			{message ? (
				<p role="status" className="text-text-secondary mt-2">
					{message}
				</p>
			) : null}
			{error ? (
				<p role="alert" className="text-status-red mt-2">
					{error}
				</p>
			) : null}
		</section>
	);
}
