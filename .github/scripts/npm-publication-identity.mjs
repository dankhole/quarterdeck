import { spawnSync } from "node:child_process";

/** An immutable npm version is reusable only when it came from the release tag's commit. */
export function getNpmPublicationState({ version, sourceSha }, run = spawnSync) {
	if (
		typeof version !== "string" ||
		!/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/u.test(version) ||
		typeof sourceSha !== "string" ||
		!/^[a-f\d]{40}$/u.test(sourceSha)
	) {
		throw new Error("A release version and full immutable source SHA are required.");
	}
	const result = run(
		"npm",
		["view", `quarterdeck@${version}`, "version", "gitHead", "--json", "--registry=https://registry.npmjs.org"],
		{ encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 },
	);
	if (result.error || result.signal || result.status === null)
		throw new Error("Could not safely determine npm publication identity.");
	let metadata;
	try {
		metadata = JSON.parse(result.stdout);
	} catch {
		throw new Error("npm returned invalid publication metadata.");
	}
	if (result.status !== 0) {
		if (metadata?.error?.code === "E404") return "absent";
		throw new Error("Could not safely determine npm publication identity.");
	}
	if (
		!metadata ||
		typeof metadata !== "object" ||
		Array.isArray(metadata) ||
		metadata.version !== version ||
		metadata.gitHead !== sourceSha
	) {
		throw new Error("The published npm version does not match the immutable release source. Use a new version.");
	}
	return "published";
}
