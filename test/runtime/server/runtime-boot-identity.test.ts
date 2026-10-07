import { describe, expect, it, vi } from "vitest";
import { readRuntimeBootIdentity } from "../../../src/server/runtime-boot-identity";

const UUID = "A1234567-1234-1234-1234-123456789ABC";
describe("runtime boot identity", () => {
	it("uses Linux kernel boot UUID and Darwin boot-session UUID", async () => {
		expect(await readRuntimeBootIdentity({ platform: "linux", readLinuxBootId: async () => `${UUID}\n` })).toBe(
			`linux:${UUID.toLowerCase()}`,
		);
		const query = vi.fn(async () => UUID);
		expect(await readRuntimeBootIdentity({ platform: "darwin", query })).toBe(`darwin:${UUID.toLowerCase()}`);
		expect(query).toHaveBeenCalledWith("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]);
	});

	it("uses Windows kernel boot GUID and an encoded bounded native query", async () => {
		const query = vi.fn(async (_binary: string, _args: readonly string[]) => UUID);
		expect(await readRuntimeBootIdentity({ platform: "win32", query })).toBe(`windows:${UUID.toLowerCase()}`);
		const args = query.mock.calls[0]?.[1] as readonly string[] | undefined;
		expect(args).toContain("-EncodedCommand");
	});

	it("keeps unavailable or malformed OS identity unknown", async () => {
		expect(
			await readRuntimeBootIdentity({
				platform: "darwin",
				query: async () => {
					throw new Error("unavailable");
				},
			}),
		).toBeNull();
		expect(await readRuntimeBootIdentity({ platform: "linux", readLinuxBootId: async () => "garbage" })).toBeNull();
		expect(await readRuntimeBootIdentity({ platform: "win32", query: async () => "no timestamp" })).toBeNull();
		expect(
			await readRuntimeBootIdentity({
				platform: "win32",
				query: async () => "00000000-0000-0000-0000-000000000000",
			}),
		).toBeNull();
		expect(await readRuntimeBootIdentity({ platform: "freebsd" })).toBeNull();
	});
});
