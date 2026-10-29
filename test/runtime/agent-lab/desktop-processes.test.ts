import type * as childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { findAgentLabBrowserProcessTree } from "../../../scripts/agent-lab/browser-processes";

import {
	collectOwnedDesktopProcesses,
	findMarkedDesktopProcesses,
	listDesktopProcesses,
	parseDesktopProcessList,
	stopOwnedDesktopProcesses,
} from "../../../scripts/agent-lab/desktop-processes";
import type { DesktopLabProcess } from "../../../scripts/agent-lab/desktop-types";

const processList = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>();
	return {
		...actual,
		execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: processList.run }),
	};
});

function processRecord(
	pid: number,
	parentPid: number,
	command = `process-${pid}`,
	startedAt = "Thu Oct  1 12:00:00 2026",
): DesktopLabProcess {
	return { pid, parentPid, command, startedAt };
}

describe("desktop lab owned process cleanup", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.clearAllMocks();
	});

	it.each([
		["it_IT.UTF-8", "gio ott  1 12:00:00 2026"],
		["nl_NL.UTF-8", "do  okt  1 12:00:00 2026"],
	])("keeps browser discovery admissible with a localized %s desktop census", async (locale, localizedBirth) => {
		vi.stubEnv("LC_ALL", locale);
		vi.stubEnv("LC_TIME", locale);
		vi.stubEnv("LANG", locale);
		vi.stubEnv("LC_CTYPE", "UTF-8");
		const daemonPath = "/repo/café/web-ui/node_modules/playwright-core/lib/entry/cliDaemon.js";
		processList.run.mockImplementation(
			async (_command: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
				const englishDates = options.env?.LC_TIME === "C" && !options.env.LC_ALL;
				const birth = englishDates ? "Thu Oct  1 12:00:00 2026" : localizedBirth;
				return {
					stdout: `10 1 S ${birth} /bin/node ${daemonPath} qd-localized-census\n11 10 S ${birth} /tmp/chrome-headless-shell\n`,
					stderr: "",
				};
			},
		);
		const census = await listDesktopProcesses();
		const tree = await findAgentLabBrowserProcessTree("/repo/café", "qd-localized-census", {
			platform: "darwin",
			resolveDaemonEntrypoint: () => daemonPath,
			runProcessList: async () => ({
				ok: true,
				stdout: census
					.map(({ pid, parentPid, startedAt, command }) => `${pid} ${parentPid} ${startedAt} ${command}`)
					.join("\n"),
			}),
		});
		expect(tree.rootPids).toEqual([10]);
		expect(tree.processPids).toEqual([10, 11]);
		expect(processList.run).toHaveBeenCalledWith(
			"/bin/ps",
			["-ax", "-o", "pid=,ppid=,stat=,lstart=,command="],
			expect.objectContaining({
				env: expect.objectContaining({ LC_TIME: "C", LC_CTYPE: locale, LANG: locale, TZ: "UTC" }),
			}),
		);
		expect(processList.run.mock.calls[0]?.[2]?.env?.LC_ALL).toBeUndefined();
	});

	it("parses macOS process identities while excluding zombies", () => {
		expect(
			parseDesktopProcessList(
				" 100 1 S Thu Oct  1 12:00:00 2026 /Applications/Quarterdeck.app/Contents/MacOS/Quarterdeck --user-data-dir=/tmp/lab\n101 100 Z Thu Oct  1 12:00:01 2026 zombie\n",
			),
		).toEqual([
			processRecord(100, 1, "/Applications/Quarterdeck.app/Contents/MacOS/Quarterdeck --user-data-dir=/tmp/lab"),
		]);
	});

	it("keeps tracked orphan descendants and excludes PID reuse and unrelated apps", () => {
		const main = processRecord(100, 1);
		const helper = processRecord(101, 100);
		const agent = processRecord(102, 101);
		const first = collectOwnedDesktopProcesses([main, helper, agent, processRecord(110, 1)], [100]);
		expect(first.map((entry) => entry.pid)).toEqual([100, 101, 102]);
		const reusedMain = processRecord(100, 1, "unrelated", "Thu Oct  1 12:01:00 2026");
		expect(
			collectOwnedDesktopProcesses(
				[reusedMain, { ...helper, parentPid: 1 }, agent, processRecord(110, 1)],
				[100],
				first,
			).map((entry) => entry.pid),
		).toEqual([101, 102]);
	});

	it("requires both packaged path and the run marker to find failed-launch remnants", () => {
		const appPath = "/tmp/artifact/Quarterdeck.app";
		expect(
			findMarkedDesktopProcesses(
				[
					processRecord(100, 1, `${appPath}/Contents/MacOS/Quarterdeck --user-data-dir=/tmp/run/user-data`),
					processRecord(
						101,
						1,
						`${appPath}/Contents/Resources/node --simulate-host-integrations /tmp/run/host.json`,
					),
					processRecord(102, 1, `${appPath}/Contents/MacOS/Quarterdeck --user-data-dir=/tmp/other/user-data`),
					processRecord(103, 1, "/usr/bin/node --simulate-host-integrations /tmp/run/host.json"),
					processRecord(104, 1, `${appPath}/Contents/MacOS/Quarterdeck --user-data-dir=/tmp/run/user-data-other`),
					processRecord(
						105,
						1,
						`${appPath}/Contents/Resources/node --simulate-host-integrations /tmp/run/host.json-other`,
					),
				],
				appPath,
				"/tmp/run/user-data",
				"/tmp/run/host.json",
			),
		).toEqual([100, 101]);
	});

	it("terminates exact descendants and checks that none remain", async () => {
		let running = [processRecord(100, 1), processRecord(101, 100), processRecord(102, 101)];
		const signals: Array<[number, string]> = [];
		expect(
			await stopOwnedDesktopProcesses([running[0] as DesktopLabProcess], {
				list: async () => running,
				signal: (pid, signal) => {
					signals.push([pid, signal]);
					running = running.filter((entry) => entry.pid !== pid);
				},
				wait: async () => {},
			}),
		).toEqual([]);
		expect(signals).toEqual([
			[102, "SIGTERM"],
			[101, "SIGTERM"],
			[100, "SIGTERM"],
		]);
	});

	it("escalates surviving owned processes but never signals a reused PID", async () => {
		const original = processRecord(100, 1);
		let running = [original, processRecord(101, 100)];
		const signals: Array<[number, string]> = [];
		expect(
			await stopOwnedDesktopProcesses([original], {
				list: async () => running,
				signal: (pid, signal) => {
					signals.push([pid, signal]);
					if (pid === 100)
						running = [processRecord(100, 1, "reused", "Thu Oct  1 12:01:00 2026"), processRecord(101, 1)];
					if (signal === "SIGKILL") running = running.filter((entry) => entry.pid !== pid);
				},
				wait: async () => {},
			}),
		).toEqual([]);
		expect(signals).toEqual([
			[101, "SIGTERM"],
			[100, "SIGTERM"],
			[101, "SIGKILL"],
		]);
	});

	it("reports exact survivors if fallback cleanup cannot terminate them", async () => {
		const main = processRecord(100, 1);
		expect(
			await stopOwnedDesktopProcesses([main], {
				list: async () => [main],
				signal: () => {},
				wait: async () => {},
			}),
		).toEqual([100]);
	});
});
