# Windows Runtime Compatibility Fixes

**Date**: 2026-04-09
**Scope**: Runtime source files in `src/` only — no tests, CI, build scripts, or dev tooling

## Behavioral Change Statement

**BEFORE**: Several runtime code paths use Unix-only constructs (`/dev/null`, `process.kill(pid, 0)`, `SIGHUP`/`SIGQUIT` signals, unconditional `chmod`, case-sensitive lock ordering, Unix symlink types, `~` display path). A Windows user launching Quarterdeck hits crashes or silent failures.

**AFTER**: All runtime code paths handle Windows correctly via small, targeted platform conditionals. No new abstractions. No overengineering.

**SCOPE**: 7 files in `src/`, each receiving 1-10 line changes.

## Constraint

Keep changes minimal. Prefer `process.platform === "win32"` ternaries over abstractions.

---

## Fix 1: `/dev/null` in git diff

**File**: `src/workspace/task-worktree.ts:209`

**Problem**: `git diff --binary --no-index -- /dev/null <path>` fails on Windows — `/dev/null` doesn't exist.

**Fix**: Replace `/dev/null` with a platform-conditional null device path.

```typescript
const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
// then use nullDevice in the git args
```

**Verification**: `git diff --binary --no-index -- NUL <file>` produces the same diff output on Windows as `/dev/null` does on Unix.

---

## Fix 2: `isProcessAlive` liveness check

**File**: `src/terminal/session-reconciliation.ts:16-23`

**Problem**: `process.kill(pid, 0)` catches all errors and returns `false`. On Windows (and even Unix), `EPERM` means the process exists but you don't have permission — it should return `true`.

**Fix**: Adopt the more robust pattern from `scripts/dogfood.mjs:30-48` — distinguish `EPERM` (alive) from `ESRCH` (dead).

```typescript
export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: unknown) {
        if (typeof error === "object" && error !== null && "code" in error) {
            if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
            if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        }
        return false;
    }
}
```

**Note**: This is a correctness improvement on ALL platforms, not just Windows.

---

## Fix 3: Signal registration on Windows

**File**: `src/core/graceful-shutdown.ts:48, 197-203`

**Problem**: `SIGQUIT` is not supported on Windows and may throw when listened. `SIGHUP` exists but has different semantics. Both are unnecessary for Windows shutdown.

**Fix**: Filter the signal array on Windows before registration.

```typescript
const signals = process.platform === "win32"
    ? DEFAULT_HANDLED_SIGNALS.filter((s) => s !== "SIGHUP" && s !== "SIGQUIT")
    : DEFAULT_HANDLED_SIGNALS;
```

Use the filtered array in the registration loop. Also filter in the `uninstall` function iteration (already safe since it only removes what was registered, but the map won't have these keys).

---

## Fix 4: Symlink junction fallback

**File**: `src/workspace/task-worktree.ts:33, 43`

**Problem**: `fs.symlink(source, target, "dir")` requires Developer Mode or admin privileges on Windows. Without them, symlinks silently fail (caught, returns "skipped") and worktrees miss mirrored paths like `node_modules`.

**Fix**: On Windows, use `"junction"` type for directories. Junctions don't require elevated privileges on NTFS and work with absolute paths (which `sourcePath` always is).

```typescript
// line 43: change the type selection
const symlinkType = options.isDirectory
    ? (process.platform === "win32" ? "junction" : "dir")
    : "file";
await createSymlink(options.sourcePath, options.targetPath, symlinkType);
```

Update the `CreateSymlink` type to accept `"junction"`:
```typescript
type CreateSymlink = (target: string, path: string, type: "dir" | "file" | "junction") => Promise<void>;
```

**Note**: File symlinks still require Dev Mode on Windows. The existing error catch returns "skipped", which is acceptable — file symlinks in ignored paths are rare.

---

## Fix 5: `chmod` platform guard

**File**: `src/fs/locked-file-system.ts:128, 137`

**Problem**: `chmod(path, 0o755)` is a no-op on Windows. Currently dormant (no caller passes `executable: true`), but should be guarded for when it's used.

**Fix**: Wrap both calls:

```typescript
if (options.executable && process.platform !== "win32") {
    await chmod(path, 0o755);
}
```

---

## Fix 6: Lock ordering case sensitivity

**File**: `src/fs/locked-file-system.ts:102`

**Problem**: `localeCompare()` is case-sensitive. On Windows (case-insensitive FS), `C:\Foo.lock` and `c:\foo.lock` could sort differently and deadlock.

**Fix**: Normalize sortKey to lowercase on Windows:

```typescript
const orderedRequests = normalizedRequests
    .slice()
    .sort((left, right) => {
        const l = process.platform === "win32" ? left.sortKey.toLowerCase() : left.sortKey;
        const r = process.platform === "win32" ? right.sortKey.toLowerCase() : right.sortKey;
        return l.localeCompare(r);
    });
```

---

## Fix 7: Display path tilde convention

**File**: `src/workspace/task-worktree-path.ts:6, 36`

**Problem**: `~/.quarterdeck/worktrees` is Unix convention. Windows users expect `%USERPROFILE%\.quarterdeck`.

**Note**: `QUARTERDECK_TASK_WORKTREES_DISPLAY_ROOT` and `buildTaskWorktreeDisplayPath` are currently exported but not imported by any runtime code. This fix is for correctness when they are eventually consumed.

**Fix**: Make the display root platform-aware:

```typescript
import { homedir } from "node:os";
import { join } from "node:path";

// Replace the static constant with a function
export function getTaskWorktreesDisplayRoot(): string {
    if (process.platform === "win32") {
        return join(homedir(), QUARTERDECK_TASK_WORKTREES_HOME_DIR_NAME);
    }
    return `~/${QUARTERDECK_TASK_WORKTREES_HOME_DIR_NAME}`;
}
```

Update `buildTaskWorktreeDisplayPath` to call the function.

---

## Success Criteria

1. All 7 fixes compile without type errors: `npm run typecheck`
2. All existing tests pass: `npm run test:fast`
3. No new abstractions, no new files, no new dependencies
