import { repoRoot } from "../desktop/scripts/paths.mjs";
import { buildDesktopCheckout, linkCheckout } from "./dependency-workflow.mjs";

const action = process.argv[2];
if (!["build", "install"].includes(action) || process.argv.length !== 3) {
	throw new Error("Use npm run desktop:build or npm run desktop:install.");
}
if (action === "install") {
	await linkCheckout(repoRoot, { desktop: true });
} else {
	await buildDesktopCheckout(repoRoot);
}
