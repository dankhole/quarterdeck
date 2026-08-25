#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
	AgentBrowserActionBlockedError,
	assertAgentBrowserActionCanLaunch,
	beginAgentBrowserAction,
	completeAgentBrowserAction,
} from "./agent-lab/browser-actions";
import { AGENT_LAB_REPO_ROOT, getAgentBrowserLocalPaths, prepareAgentLabBrowserCache } from "./agent-lab/paths";

async function main(): Promise<void> {
	const browserArguments = process.argv.slice(2);
	await assertAgentBrowserActionCanLaunch(browserArguments);
	let actionContext = null;
	try {
		actionContext = await beginAgentBrowserAction(browserArguments);
	} catch (error) {
		if (error instanceof AgentBrowserActionBlockedError) throw error;
	}

	const browserCache = await prepareAgentLabBrowserCache();
	const browserCachePath = browserCache.path;
	const { daemonSessionPath, browserHomePath } = getAgentBrowserLocalPaths();
	const cliPath = join(AGENT_LAB_REPO_ROOT, "web-ui", "node_modules", "@playwright", "cli", "playwright-cli.js");

	await Promise.all([mkdir(daemonSessionPath, { recursive: true }), mkdir(browserHomePath, { recursive: true })]);

	if (browserCache.status === "migrated") {
		process.stderr.write(
			"[agent-browser] Reused the complete legacy Chromium cache in its durable shared location.\n",
		);
	}

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

	try {
		await assertAgentBrowserActionCanLaunch(browserArguments);
	} catch (error) {
		const launchError = error instanceof Error ? error : new Error(String(error));
		await completeAgentBrowserAction(actionContext, {
			exitCode: null,
			signal: null,
			error: launchError,
		}).catch(() => {});
		throw launchError;
	}

	const child = spawn(process.execPath, [cliPath, ...browserArguments], {
		cwd: AGENT_LAB_REPO_ROOT,
		env: environment,
		stdio: "inherit",
	});

	const result = await new Promise<{
		exitCode: number | null;
		signal: NodeJS.Signals | null;
		error: Error | null;
	}>((resolveResult) => {
		let settled = false;
		const settle = (value: { exitCode: number | null; signal: NodeJS.Signals | null; error: Error | null }) => {
			if (settled) return;
			settled = true;
			resolveResult(value);
		};
		child.once("error", (error) => settle({ exitCode: null, signal: null, error }));
		child.once("exit", (exitCode, signal) => settle({ exitCode, signal, error: null }));
	});

	await completeAgentBrowserAction(actionContext, result).catch(() => {});
	if (result.error) throw result.error;
	if (result.signal) {
		process.kill(process.pid, result.signal);
	} else {
		process.exitCode = result.exitCode ?? 1;
	}
}

await main().catch((error: unknown) => {
	process.stderr.write(`[agent-browser] ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
