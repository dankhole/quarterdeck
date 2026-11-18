---
name: quarterdeck-functional-testing
description: Build and exercise an isolated packaged Quarterdeck macOS or Windows app with hidden Electron automation, synthetic projects and a deterministic fake coding agent. Use for functional, visual, terminal lifecycle, Git/Files, host-integration and desktop packaging regressions, or explicitly authorized real-provider compatibility checks. Not for ordinary unit tests or the user's active instance.
---

# Quarterdeck Functional Testing

Read [testing strategy](../../../docs/testing.md) to select the smallest useful scenario, then [Agent Lab operation](../../../docs/agent-functional-testing.md) for packaged execution, provider boundaries and evidence. Desktop-only product support does not remove internal headless testing: keep hidden Electron, isolated runtime fixtures, fake providers and useful Linux source tests. Standalone browser product access and its old lab/wrapper commands are removed.

## Prepare and run

Use a freshly packaged inspection-enabled candidate following the [desktop release guide](../../../docs/desktop-release.md). Do not attach to the user's active app, launch a normal dev/dogfood instance as a substitute, overwrite a global installation, or automate a stale app after changing source.

```text
npm run --silent agent:desktop -- smoke --app <absolute-packaged-app-path> --json
```

On macOS use the `.app`; on Windows use the packaged application directory. The lab owns disposable runtime state, Electron storage, installation paths, synthetic projects, tracked processes and cleanup. It is not a hardened security sandbox. Use synthetic data only.

Keep windows hidden. `--show-window` is only for explicit visibility/focus claims and can take focus. `--no-agent` does not establish PTY, hooks or exact provider resume. Read `smoke --help` and select the narrowest scenario: manual shells, compare window, notifications, npm launch handoff, native experience, main loss or session recovery. Do not run a full recovery smoke for an unrelated UI change.

The default fake smoke intentionally crashes a renderer and may display an OS alert despite hidden execution. Explain that before running it. Non-crash scenarios should be preferred when crash recovery is not part of the claim. Native runs require application/socket/process-inspection permission; do not retry an OS registration failure blindly or change global crash-report settings.

Public production fuses disable the inspector used by the lab. Build a local candidate rather than weakening public artifacts. The test-only mock keychain avoids touching the user's macOS Keychain; never reset Keychain, strip quarantine or disable Gatekeeper.

## Observe and prove

Use the repo-owned Electron driver and scenario modules under `scripts/agent-lab/`. Drive only the isolated synthetic app. Assert semantic state and exact runtime/task/process identities; screenshots are required only for visual claims. UI input/output is not authoritative evidence of Running: require a current launch-scoped provider hook.

For manual terminals, Hide/detach must preserve the exact shell session/process and explicit Terminate must retire it. For task recovery, require exact provider session identity, fresh PTY and current hook. Renderer refresh is not a cold runtime restart; select a recovery scenario only when persistence/startup/exact-resume behavior is part of the claim.

Inspect the typed simulated-host ledger for IDE/file/folder/URL/clipboard/notification intent and outcome. Simulation does not prove a physical OS dialog, sound, clipboard or notification. Hidden execution does not establish Dock/taskbar/focus behavior. Keep native-platform acceptance gaps explicit.

The fake terminal command protocol remains in [references/protocol.md](references/protocol.md). Do not put secrets or real project content into inputs, screenshots or retained diagnostic artifacts.

## Real providers

Default to `fake`. Use `--provider real-codex` or `--provider real-claude` only after explicit user/account authorization and only when real TUI, hooks, event order, version compatibility or exact resume is the unresolved risk. First pass a fresh candidate through fake smoke. Keep prompts tiny and synthetic; never use real providers in CI. No real-provider use is implied by a request to run tests.

Keep effectful commands behind normal approval. The packaged real scenario holds a permission request without approving it and verifies that the write did not occur; this is not an explicit Deny test. Never send guessed numeric answers. Read the owning provider-policy modules for exact isolation and auth behavior; removed browser-lab options are not supported command contracts. Interactive Claude has no enforced budget ceiling.

When a scenario requests screenshot review, inspect the actual PNG, verify the exact run/task/process/document/output identity and return only its requested accept/refuse observation. This is an observation, not approval or extra user authorization. A composer visible while resuming is not ready for input.

## Finish

The runner always attempts shutdown. Inspect `desktop-manifest.json`, candidate build/artifact identity, checkpoints, forbidden-host-launch evidence, shutdown evidence and remaining processes even if execution fails. Require confirmed graceful Quit without fallback termination for a passing acceptance claim. Preserve an unconfirmed fixture and exact process evidence; do not kill by executable name or delete live state.

Report the scenario, exact candidate identity, observed result, evidence paths, cleanup outcome and untested native/public-release boundaries. Native Windows/ARM64/minimum OS, signing/approval, public updates and elapsed daily use require their own evidence; source tests and hidden local runs do not establish them.
