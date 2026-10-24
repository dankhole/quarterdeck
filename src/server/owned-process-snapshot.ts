import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { mergeProcessEnvironment } from "../core/process-environment.js";
import { queryWindowsProcessTreeSnapshot } from "../core/windows-process-snapshot.js";

/** Ordering is meaningful only within the same source clock (and Linux boot). */
export type OwnedProcessBirthTime =
	| { clock: "windows"; value: bigint }
	| { clock: "linux"; bootId: string; value: bigint }
	| { clock: "bsd"; value: bigint };

export interface OwnedProcessSnapshot {
	pid: number;
	parentPid: number;
	creationIdentity: string;
	/** Windows UTC ticks, Linux boot-relative ticks, or BSD UTC seconds; never Number-coerced identities. */
	birthTime?: OwnedProcessBirthTime;
	/** BSD ps has second precision: changed ancestry must fail closed. */
	preciseIdentity: boolean;
	zombie: boolean;
}

/** Null means unknown, not equal. Equal clock ticks are possible for legitimate children. */
export function compareOwnedProcessBirth(left: OwnedProcessSnapshot, right: OwnedProcessSnapshot): -1 | 0 | 1 | null {
	const a = left.birthTime;
	const b = right.birthTime;
	if (!left.creationIdentity || !right.creationIdentity || !a || !b || a.clock !== b.clock) return null;
	if (a.clock === "linux" && (b.clock !== "linux" || !a.bootId || a.bootId !== b.bootId)) return null;
	return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
}

function bsdBirthTime(fields: readonly string[]): bigint {
	const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	const month = months.indexOf(fields[3] ?? "");
	const day = Number(fields[4]);
	const time = /^(\d{2}):(\d{2}):(\d{2})$/u.exec(fields[5] ?? "");
	const year = Number(fields[6]);
	if (month < 0 || !time || !/^\d{4}$/u.test(fields[6] ?? "")) throw new Error("Unreadable process birth time.");
	const hour = Number(time[1]);
	const minute = Number(time[2]);
	const second = Number(time[3]);
	const date = new Date(0);
	date.setUTCFullYear(year, month, day);
	date.setUTCHours(hour, minute, second, 0);
	if (
		!Number.isFinite(date.getTime()) ||
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month ||
		date.getUTCDate() !== day ||
		date.getUTCHours() !== hour ||
		date.getUTCMinutes() !== minute ||
		date.getUTCSeconds() !== second
	)
		throw new Error("Unreadable process birth time.");
	return BigInt(date.getTime() / 1_000);
}

export async function queryOwnedProcessSnapshot(): Promise<OwnedProcessSnapshot[]> {
	if (process.platform === "win32") {
		return (await queryWindowsProcessTreeSnapshot()).map(
			(row): OwnedProcessSnapshot => ({
				pid: row.pid,
				parentPid: row.parentPid,
				creationIdentity: row.creationTime ?? "",
				birthTime: row.creationTime === null ? undefined : { clock: "windows", value: BigInt(row.creationTime) },
				preciseIdentity: true,
				zombie: false,
			}),
		);
	}
	if (process.platform === "linux") {
		const names = (await readdir("/proc")).filter((name) => /^\d+$/u.test(name));
		if (names.length > 10_000) throw new Error("Process snapshot exceeds its bounded size.");
		const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
		if (!bootId) throw new Error("Unreadable process boot identity.");
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
						birthTime: { clock: "linux", bootId, value: BigInt(fields[19] ?? "") },
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
		.map((line): OwnedProcessSnapshot => {
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
				birthTime: { clock: "bsd", value: bsdBirthTime(fields) },
				preciseIdentity: false,
				zombie: fields[7]?.startsWith("Z") ?? false,
			};
		});
}
