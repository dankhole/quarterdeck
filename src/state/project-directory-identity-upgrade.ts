import { lockedFileSystem } from "../fs/locked-file-system";
import { matchesProjectDirectoryIdentity, readProjectDirectoryIdentity } from "../fs/project-directory-identity";
import { readProjectRelocationJournal } from "./project-relocation-journal";
import { readProjectIndex, writeProjectIndexSafe } from "./project-state-index";
import { getProjectIndexLockRequest, isUnderWorktreesHome } from "./project-state-utils";

/** Admitted startup only: strengthen matching legacy evidence without adopting changed locations. */
export async function upgradeProjectDirectoryIdentities(): Promise<void> {
	if (process.platform !== "darwin") return;
	await lockedFileSystem.withLock(getProjectIndexLockRequest(), async () => {
		const index = await readProjectIndex();
		let changed = false;
		for (const entry of Object.values(index.entries)) {
			if (entry.directoryIdentity?.darwinBirthtimeNs || isUnderWorktreesHome(entry.repoPath)) continue;
			try {
				if (await readProjectRelocationJournal(entry.projectId)) continue;
				const observed = await readProjectDirectoryIdentity(entry.repoPath);
				if (
					!observed.darwinBirthtimeNs ||
					(entry.directoryIdentity && !matchesProjectDirectoryIdentity(entry.directoryIdentity, observed))
				)
					continue;
				entry.directoryIdentity = observed;
				entry.metadataRevision = (entry.metadataRevision ?? 0) + 1;
				changed = true;
			} catch {
				// Missing/inaccessible folders and unreadable relocation evidence remain untouched.
			}
		}
		if (changed) {
			index.version = 4;
			await writeProjectIndexSafe(index);
		}
	});
}
