#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { beginAgentBrowserAction, completeAgentBrowserAction } from "./agent-lab/browser-actions";
import { AGENT_LAB_REPO_ROOT, getAgentLabBrowserCachePath } from "./agent-lab/paths";

const browserCachePath = getAgentLabBrowserCachePath();
const daemonSessionPath = join(AGENT_LAB_REPO_ROOT, "test-results", "agent-lab", "browser-daemon");
const browserHomePath = join(AGENT_LAB_REPO_ROOT, "test-results", "agent-lab", "browser-home");
const cliPath = join(AGENT_LAB_REPO_ROOT, "web-ui", "node_modules", "@playwright", "cli", "playwright-cli.js");

await Promise.all([
	mkdir(browserCachePath, { recursive: true }),
	mkdir(daemonSessionPath, { recursive: true }),
	mkdir(browserHomePath, { recursive: true }),
]);

const environment: NodeJS.ProcessEnv = {
	PATH: process.env.PATH,
	Path: process.platform === "win32" ? (process.env.Path ?? process.env.PATH) : undefined,
	SHELL: process.env.SHELL,
	LANG: process.env.LANG,
	LC_ALL: process.env.LC_ALL,
	LC_CTYPE: process.env.LC_CTYPE,
	SystemRoot: process.env.SystemRoot,
	ComSpec: process.env.ComSpec,
	PATHEXT: process.env.PATHEXT,
	DISPLAY: process.env.DISPLAY,
	HOME: browserHomePath,
	USERPROFILE: browserHomePath,
	XDG_CACHE_HOME: join(browserHomePath, ".cache"),
	XDG_CONFIG_HOME: join(browserHomePath, ".config"),
	TMPDIR: process.env.TMPDIR,
	TEMP: process.env.TEMP,
	TMP: process.env.TMP,
	NO_COLOR: "1",
	PLAYWRIGHT_BROWSERS_PATH: browserCachePath,
	PWTEST_DAEMON_SESSION_DIR: daemonSessionPath,
};

const browserArguments = process.argv.slice(2);
const actionContext = await beginAgentBrowserAction(browserArguments).catch(() => null);
const child = spawn(process.execPath, [cliPath, ...browserArguments], {
	cwd: AGENT_LAB_REPO_ROOT,
	env: environment,
	stdio: "inherit",
});

const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; error: Error | null }>(
	(resolveResult) => {
		let settled = false;
		const settle = (value: { exitCode: number | null; signal: NodeJS.Signals | null; error: Error | null }) => {
			if (settled) return;
			settled = true;
			resolveResult(value);
		};
		child.once("error", (error) => settle({ exitCode: null, signal: null, error }));
		child.once("exit", (exitCode, signal) => settle({ exitCode, signal, error: null }));
	},
);

await completeAgentBrowserAction(actionContext, result).catch(() => {});
if (result.error) {
	process.stderr.write(`[agent-browser] ${result.error.message}\n`);
	process.exitCode = 1;
} else if (result.signal) {
	process.kill(process.pid, result.signal);
} else {
	process.exitCode = result.exitCode ?? 1;
}
