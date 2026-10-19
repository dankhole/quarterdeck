import { stat } from "node:fs/promises";
import { z } from "zod";

export const projectDirectoryIdentitySchema = z.object({
	device: z.string().min(1),
	inode: z.string().min(1),
	darwinBirthtimeNs: z
		.string()
		.regex(/^[1-9]\d*$/u)
		.optional(),
});

export type ProjectDirectoryIdentity = z.infer<typeof projectDirectoryIdentitySchema>;

export async function readProjectDirectoryIdentity(path: string): Promise<ProjectDirectoryIdentity> {
	const entry = await stat(path, { bigint: true });
	if (!entry.isDirectory()) throw new Error("The selected path is not a folder.");
	return {
		device: entry.dev.toString(),
		inode: entry.ino.toString(),
		// Darwin supplies native creation time. Other platforms may substitute mutable ctime.
		...(process.platform === "darwin" && entry.birthtimeNs > 0n
			? { darwinBirthtimeNs: entry.birthtimeNs.toString() }
			: {}),
	};
}

/** Saved evidence comes first. Legacy identities never infer missing historical creation time. */
export function matchesProjectDirectoryIdentity(
	expected: ProjectDirectoryIdentity,
	observed: ProjectDirectoryIdentity,
): boolean {
	if (expected.inode !== observed.inode) return false;
	if (expected.darwinBirthtimeNs !== undefined) {
		return expected.darwinBirthtimeNs === observed.darwinBirthtimeNs;
	}
	return expected.device === observed.device;
}
