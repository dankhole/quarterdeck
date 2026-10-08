import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup(): () => Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "quarterdeck-suite-home-"));
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	// Vitest creates worker environments after global setup. Keep the default
	// state-home override unset so fixtures may select their own HOME normally.
	process.env.HOME = home;
	process.env.USERPROFILE = home;

	return async () => {
		try {
			await rm(home, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 });
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
		}
	};
}
