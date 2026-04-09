# fs.watch Platform Quirks

Reference for a potential future optimization: replacing timer-based git polling with filesystem watchers on `.git/HEAD` and `.git/index` to make idle worktrees near-zero cost. Deferred due to implementation complexity — the polling improvements (configurable intervals, focused-task priority, concurrency limiting) get most of the benefit without this.

## macOS (FSEvents)

- Works well in general, but `fs.watch` on macOS uses FSEvents under the hood, which is directory-level. Watching `.git/index` can fire duplicate events (2-3 per single write) because git writes atomically via temp file + rename.
- FSEvents has a coalescing delay (~100ms) that can batch rapid changes, so you might miss intermediate states — fine for our use case since we just want "something changed, go probe."
- Worktrees use a `.git` *file* (not directory) that points to the parent repo's `.git/worktrees/<name>/`. You'd need to resolve that indirection and watch the actual files inside the parent `.git` directory, not the worktree's `.git` file.

## Linux (inotify)

- Solid and reliable, but has a system-wide watch limit (`fs.inotify.max_user_watches`, default 8192 on many distros). Each watched path consumes a descriptor. With 10 worktrees watching 2-3 files each it's fine, but if Quarterdeck runs alongside VS Code or other watchers, you can hit the limit and get silent failures.
- inotify doesn't work on network filesystems (NFS, CIFS, SSHFS). If someone runs Quarterdeck on a remote mount, watches silently do nothing.

## Windows (ReadDirectoryChangesW)

- Not yet tested. Node's `fs.watch` on Windows uses `ReadDirectoryChangesW`, which is directory-level and generally reliable on NTFS. Should behave similarly to macOS (duplicate events, need to handle temp file renames).
- Git for Windows uses different locking behavior than Unix — `core.fsmonitor` integration may be worth investigating as an alternative to raw `fs.watch`.

## Both/all platforms

- `fs.watch` can emit events when git runs `--no-optional-locks` read operations on some filesystems — false positives that trigger unnecessary probes.
- Node's `fs.watch` API is explicitly documented as "not 100% consistent across platforms." The callback can fire with `'rename'` or `'change'` inconsistently for the same underlying operation.

## Upshot

fs.watch would need a polling fallback anyway (for network filesystems and reliability), meaning two code paths to maintain. Highest-ceiling optimization but also the most maintenance burden. Revisit after the polling interval and concurrency improvements are in place — they may reduce resource usage enough that fs.watch becomes unnecessary.
