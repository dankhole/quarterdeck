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
	const unapplied =
		preferences &&
		(snapshot.appliedImportLoginShellEnvironment !== preferences.importLoginShellEnvironment ||
			JSON.stringify(snapshot.appliedDirectories) !== JSON.stringify(preferences.extraExecutableDirectories));

	return (
		<section className="mt-4 text-[13px]" aria-labelledby="desktop-environment-heading">
			<h5 id="desktop-environment-heading" className="font-semibold text-text-primary mb-2">
				Runtime Environment
			</h5>
			{snapshot?.ownership === "attached" ? (
				<p className="text-text-secondary">
					This runtime belongs to the CLI. Change its shell environment and restart the owning CLI to apply it.
				</p>
			) : (
				<>
					<div className="settings-row">
						<div className="flex items-center gap-2">
							<SettingsCheckbox
								id="desktop-import-login-shell"
								checked={preferences?.importLoginShellEnvironment ?? false}
								disabled={disabled}
								onCheckedChange={(enabled) => void request({ kind: "set-login-shell-import", enabled })}
							/>
							<label htmlFor="desktop-import-login-shell">Import login-shell environment</label>
						</div>
						<p className="text-text-secondary mt-1 mb-2">
							Enabled by default so agents receive exported provider settings, including LiteLLM, from your
							shell. Runs shell startup files, which may request Keychain access. Disable it to troubleshoot
							startup.
						</p>
						<p className="text-text-secondary my-2">
							Environment changes save immediately, separately from Save below. Refresh Environment or restart
							Quarterdeck to apply them. Refresh protects unsaved work and confirms live sessions.
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
					<div className="settings-row">
						{preferences ? (
							<>
								<p className="font-semibold mb-1">Extra executable folders</p>
								{preferences.extraExecutableDirectories.length ? (
									<ul className="list-disc pl-5 text-text-secondary font-mono text-xs break-all">
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
								Reset folders
							</Button>
							<Button size="sm" disabled={busy || !snapshot} onClick={() => void request({ kind: "refresh" })}>
								Refresh Environment
							</Button>
						</div>
					</div>
					{snapshot && !preferences ? (
						<div className="mt-2">
							<p className="text-status-orange">
								Saved environment settings could not be read. Reset clears saved folders and disables shell
								import.
							</p>
							<Button size="sm" disabled={busy} onClick={() => void request({ kind: "reset-preferences" })}>
								Reset environment settings
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
