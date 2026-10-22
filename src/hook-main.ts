import { main } from "./hook-entry.js";

/**
 * Real process entry point for `dist/hooks.js` (see `scripts/build.mjs`). Kept
 * separate from `hook-entry.ts` so that module has no import-time side effect
 * and tests can import its exports directly — no "am I the real entry point"
 * guard needed (an earlier version of this file compared `import.meta.url` to
 * `process.argv[1]`, which silently no-ops under a symlinked invocation path).
 * Mirrors `src/cli.ts`'s own `void run().catch(...)` + explicit `process.exit`
 * pattern so a lingering open handle (e.g. a slow retry's socket) can't extend
 * the hook process past its intended lifetime.
 */
void main()
	.catch((error) => {
		process.stderr.write(`quarterdeck hooks: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	})
	.finally(() => {
		process.exit(process.exitCode ?? 0);
	});
