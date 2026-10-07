import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { mergeProcessEnvironment } from "../core/process-environment.js";
import { queryWindowsProcessTreeSnapshot } from "../core/windows-process-snapshot.js";

export interface OwnedProcessSnapshot {
	pid: number;
	parentPid: number;
	creationIdentity: string;
	/** BSD ps has second precision: changed ancestry must fail closed. */
	preciseIdentity: boolean;
	zombie: boolean;
}

export async function queryOwnedProcessSnapshot(): Promise<OwnedProcessSnapshot[]> {
	if (process.platform === "win32") {
		return (await queryWindowsProcessTreeSnapshot()).map((row) => ({
			pid: row.pid,
			parentPid: row.parentPid,
			creationIdentity: row.creationTime ?? "",
			preciseIdentity: true,
			zombie: false,
		}));
	}
	if (process.platform === "linux") {
		const names = (await readdir("/proc")).filter((name) => /^\d+$/u.test(name));
		if (names.length > 10_000) throw new Error("Process snapshot exceeds its bounded size.");
		const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
		const rows = await Promise.all(
			names.map(async (name): Promise<OwnedProcessSnapshot | null> => {
				try {
					const stat = await readFile(`/proc/${name}/stat`, "utf8");
					const fields = stat
						.slice(stat.lastIndexOf(")") + 2)
						.trim()
						.split(/\s+/u);
					const parentPid = Number(fields[1]);
					if (!Number.isSafeInteger(parentPid) || !/^\d+$/u.test(fields[19] ?? "")) {
						throw new Error("Unreadable process identity.");
					}
					return {
						pid: Number(name),
						parentPid,
						creationIdentity: `${bootId}:${fields[19]}`,
						preciseIdentity: true,
						zombie: fields[0] === "Z",
					};
				} catch (error) {
					if (
						(error as NodeJS.ErrnoException).code === "ENOENT" ||
						(error as NodeJS.ErrnoException).code === "ESRCH"
					)
						return null;
					throw error;
				}
			}),
		);
		return rows.filter((row): row is OwnedProcessSnapshot => row !== null);
	}
	const stdout = await new Promise<string>((resolve, reject) => {
		execFile(
			"/bin/ps",
			["-A", "-o", "pid=,ppid=,lstart=,stat="],
			{
				encoding: "utf8",
				timeout: 1_500,
				maxBuffer: 4 * 1024 * 1024,
				env: mergeProcessEnvironment(process.env, { LC_ALL: "C", TZ: "UTC" }),
			},
			(error, output) => {
				if (error) reject(new Error("Could not query process trees."));
				else resolve(output);
			},
		);
	});
	return stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const fields = line.trim().split(/\s+/u);
			const pid = Number(fields[0]);
			const parentPid = Number(fields[1]);
			if (
				fields.length !== 8 ||
				!Number.isSafeInteger(pid) ||
				pid <= 0 ||
				!Number.isSafeInteger(parentPid) ||
				parentPid < 0
			)
				throw new Error("Unreadable process tree.");
			return {
				pid,
				parentPid,
				creationIdentity: fields.slice(2, 7).join(" "),
				preciseIdentity: false,
				zombie: fields[7]?.startsWith("Z") ?? false,
			};
		});
}
