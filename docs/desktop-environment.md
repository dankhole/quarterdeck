# Desktop environment resolution

The desktop app builds its runtime environment once at startup and again only after a guarded **Refresh Environment**. Ordinary Finder/Dock startup does not run a login shell, shell initialization scripts, a version manager, or an agent executable to find executable folders. Explicit shell terminals still start their requested shell.

## PATH construction

In the default shell-free mode, the helper's effective PATH has this priority:

1. Quarterdeck's bundled Node directory.
2. Executable folders explicitly saved in **Quarterdeck → Runtime Environment…**.
3. Valid absolute entries from the app's inherited PATH, in their original order.
4. Existing common user-installation folders: `~/.local/bin`, `~/.npm-global/bin`, `~/bin`, and `$VOLTA_HOME/bin` or `~/.volta/bin`.
5. At most one selected nvm installation's `bin` directory.
6. Standard fallback folders: `/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`.

Duplicate folders are removed without changing the first occurrence. Empty, relative, or malformed PATH entries are excluded. Existing inherited entries keep their precedence even if they came from an earlier shell launch; saved executable folders can override them. The app does not install agents or repair version-manager settings. Custom npm prefixes, unsupported manager layouts, and project-specific version selections can be configured with the folder picker.

Discovery uses the inherited absolute `HOME`, falling back to the operating-system home directory. An absolute `VOLTA_HOME` or `NVM_DIR` selects a custom installation root. Discovery reads directories and bounded regular metadata files; it never evaluates shell syntax or sources manager scripts. Environment values and file contents are not logged.

### nvm selection

The app examines `$NVM_DIR/versions/node` or `~/.nvm/versions/node`. It follows a bounded `alias/default` chain, including named and `lts/…` aliases, and selects the highest installed stable version matching an exact, major, or major/minor selector. `node` and `stable` select the highest installed stable version. An explicit `system` default contributes no nvm folder. With a missing, invalid, cyclic, or unavailable default, it falls back to the highest usable installed stable version. Numeric version ordering makes selection independent of filesystem enumeration order.

This is filesystem discovery, not the full nvm command contract: it does not inspect a project's `.nvmrc`, fetch releases, interpret arbitrary aliases, or choose a version separately for each task. Directory enumeration is capped at 512 entries, alias files at 1 KiB, and alias resolution at eight steps. Oversized or inaccessible installations are skipped; saved folders remain the escape hatch.

## Optional login-shell import

Enable **Import Login Shell Environment** in Runtime Environment when agents require variables that exist only in shell startup files. The saved choice takes effect on the next app startup or after **Refresh Environment** completes. Import runs startup files, which can execute commands or request Keychain access. Disabling import prevents future startup captures; values already inherited from the launching process remain inherited.

Import uses a fixed interactive login command so setup in files such as `.zshrc` is included. Standard input, output, and error streams are discarded; environment records use a separate private bounded channel. Its PATH comes from the captured shell environment rather than common-folder/nvm discovery; failed capture falls back to sanitized inherited PATH and standard folders. Bundled Node and saved folder overrides still take precedence. Import preserves environment sanitization, timeout and output limits, owned-process cleanup, and typed fallback guidance. Failed capture cannot silently report successful shell import. Unconfirmed capture cleanup blocks runtime startup. Shell-defined values remain in memory and are not written to preferences or diagnostics.

The strict version-1 preference file remains compatible with existing folder-only records: an absent import choice means disabled. Adding or resetting folder overrides preserves the choice; resetting malformed preferences restores the shell-free default. The native dialog distinguishes the saved preference from the configuration used by the current runtime. Saving alone does not restart a runtime.

Environment refresh retains draft protection, live-session confirmation, confirmed shutdown, and restart. A runtime owned by an already running CLI remains read-only from this menu and uses its CLI process environment. Synthetic Agent Lab startup skips ambient discovery and shell capture, preserving its fixture environment.

## Ownership and validation

`desktop/src/executable-path-discovery.ts` owns bounded filesystem discovery. `launch-environment.ts` owns sanitization and optional capture. `environment-preferences.ts` owns private preference storage and explicit folder precedence. `runtime-environment.ts` composes those policies for both startup and refresh; `main.ts` owns runtime lifetime and applied-configuration status. The native controller saves intent without exposing arbitrary environment edits through renderer IPC.

Focused tests cover real filesystem layouts, alias limits and special files, default no-shell behavior, preference migration, explicit import, fallback, and override priority through the production composition. Packaged Agent Lab checks validate bundled startup and lifecycle separately; its isolated environment does not prove discovery against a user's home directory.

## Keychain prompts and signing

Shell startup files can request unrelated credentials, such as Horizon credentials. Shell-free startup avoids running those files during desktop environment resolution. A **Quarterdeck Safe Storage** prompt comes from Electron/Chromium encrypted storage and has a separate signing boundary.

Cookie encryption remains enabled. Local ad-hoc builds may require renewed Keychain permission after replacement because macOS cannot reliably recognize them as the same application across builds. Stable Developer ID signing is the distribution solution. See [Keychain continuity acceptance](./desktop-release.md#keychain-continuity) for the external signed-update checks; changing PATH does not establish their result.
