import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu;

/** Consume a completed paired build; never generate a second runtime/browser identity. */
export async function readPairedBuildIdentity(distPath) {
	const [runtime, index] = await Promise.all([
		readFile(join(distPath, "cli.js"), "utf8"),
		readFile(join(distPath, "web-ui", "index.html"), "utf8"),
	]);
	const asset = index.match(/<script[^>]+src="([^"]+\.js)"/u)?.[1];
	if (!asset) throw new Error("Paired runtime/browser build missing. Run the root `npm run build` first.");
	const webRoot = resolve(distPath, "web-ui");
	const assetPath = resolve(webRoot, asset.replace(/^\//u, ""));
	if (!assetPath.startsWith(`${webRoot}${sep}`)) throw new Error("Browser entry asset escapes the paired build.");
	const browser = await readFile(assetPath, "utf8");
	const browserIds = new Set(browser.match(uuidPattern) ?? []);
	const identities = [...new Set(runtime.match(uuidPattern) ?? [])].filter((id) => browserIds.has(id));
	if (identities.length !== 1) {
		throw new Error("Expected exactly one shared runtime/browser build UUID. Run the root `npm run build` again.");
	}
	return identities[0];
}
