import { describe, expect, it } from "vitest";

import {
	collectOwnedDesktopProcesses,
	findMarkedDesktopProcesses,
	parseDesktopProcessList,
	stopOwnedDesktopProcesses,
} from "../../../scripts/agent-lab/desktop-processes";
import type { DesktopLabProcess } from "../../../scripts/agent-lab/desktop-types";

function processRecord(
	pid: number,
	parentPid: number,
	command = `process-${pid}`,
	startedAt = "Thu Oct  1 12:00:00 2026",
): DesktopLabProcess {
	return { pid, parentPid, command, startedAt };
}

describe("desktop lab owned process cleanup", () => {
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
