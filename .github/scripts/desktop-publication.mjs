import { spawnSync } from "node:child_process";
import { appendFile, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { artifactNames, checksum, validateRelease } from "./desktop-release-artifacts.mjs";

function identity({ repository, version, sourceSha }) {
	if (
		repository !== "dankhole/quarterdeck" ||
		!/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?$/u.test(version) ||
		!/^[a-f\d]{40}$/u.test(sourceSha)
	)
		throw new Error("An exact Quarterdeck repository, version, and source SHA are required.");
	return `v${version}`;
}

function gh(args) {
	const result = spawnSync("gh", args, { encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
	if (result.error || result.status !== 0)
		throw new Error("GitHub release operation failed; no missing-release assumption is safe.");
	return result.stdout;
}

export function findRelease(options, execute = gh) {
	const tag = identity(options);
	const pages = JSON.parse(
		execute(["api", `repos/${options.repository}/releases?per_page=100`, "--paginate", "--slurp"]),
	);
	if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page)))
		throw new Error("Invalid GitHub release response.");
	const matches = pages.flat().filter((release) => release.tag_name === tag);
	if (matches.length > 1) throw new Error("Ambiguous GitHub release identity.");
	const release = matches[0] ?? null;
	if (release && (typeof release.draft !== "boolean" || !Number.isSafeInteger(release.id)))
		throw new Error("Invalid GitHub release state.");
	return release;
}

/** These requests deliberately never carry GH_TOKEN or an Authorization header. */
export async function downloadAnonymous(url, path, limit, fetcher = fetch) {
	let current = new URL(url);
	const hosts = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
	for (let redirects = 0; redirects <= 5; redirects += 1) {
		if (
			current.protocol !== "https:" ||
			!hosts.has(current.hostname) ||
			current.username ||
			current.password ||
			current.port ||
			current.hash
		)
			throw new Error("Unsafe anonymous release download URL.");
		const response = await fetcher(current, {
			redirect: "manual",
			signal: AbortSignal.timeout(120_000),
			headers: { Accept: "application/octet-stream" },
		});
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			const location = response.headers.get("location");
			await response.body?.cancel();
			if (!location) throw new Error("Release download redirect lacks a location.");
			current = new URL(location, current);
			continue;
		}
		if (!response.ok || !response.body) throw new Error(`Public release download failed (${response.status}).`);
		const declared = response.headers.get("content-length");
		if (declared && (!/^\d+$/u.test(declared) || Number(declared) > limit))
			throw new Error("Public release asset exceeds its size limit.");
		const file = await open(path, "wx", 0o600);
		try {
			let bytes = 0;
			for await (const chunk of response.body) {
				bytes += chunk.length;
				if (bytes > limit) throw new Error("Public release asset exceeds its size limit.");
				await file.write(chunk);
			}
			if (!bytes || (declared && bytes !== Number(declared)))
				throw new Error("Incomplete public release asset download.");
		} finally {
			await file.close();
		}
		return;
	}
	throw new Error("Too many release download redirects.");
}

export async function releaseChecksums(files) {
	return `${(await Promise.all(files.map(async (path) => `${await checksum(path)}  ${basename(path)}`))).join("\n")}\n`;
}

export async function verifyPublicRelease(options, directory, download = downloadAnonymous) {
	const tag = identity(options);
	await mkdir(directory, { recursive: true });
	const names = ["arm64", "x64"].flatMap((arch) => [
		...artifactNames(options.version, arch),
		`artifact-manifest-darwin-${arch}.json`,
	]);
	for (const name of [...names, "SHA256SUMS"]) {
		const limit = /\.(dmg|zip)$/u.test(name) ? 1024 * 1024 * 1024 : 128 * 1024;
		await download(
			`https://github.com/${options.repository}/releases/download/${tag}/${name}`,
			join(directory, name),
			limit,
		);
	}
	const files = await validateRelease(directory, options.version, options.sourceSha);
	if ((await readFile(join(directory, "SHA256SUMS"), "utf8")) !== (await releaseChecksums(files)))
		throw new Error("Public SHA256SUMS differs from the immutable downloaded release bytes.");
	return files;
}

/** Public releases are immutable. Only an unpublished draft permits upload retries. */
export async function publishDesktopRelease(
	options,
	{ execute = gh, inspect = findRelease, verifyPublic = verifyPublicRelease } = {},
) {
	const tag = identity(options);
	let release = inspect(options, execute);
	if (!release || release.draft) {
		const files = await validateRelease(options.directory, options.version, options.sourceSha);
		const sums = join(options.directory, "SHA256SUMS");
		await writeFile(sums, await releaseChecksums(files));
		if (!release) {
			execute([
				"release",
				"create",
				tag,
				"--repo",
				options.repository,
				"--verify-tag",
				"--draft",
				"--title",
				tag,
				"--notes",
				"Verified desktop assets pending public availability checks.",
			]);
		}
		// Recheck immediately before a mutation; a concurrent public promotion must
		// never turn --clobber into a public artifact replacement.
		release = inspect(options, execute);
		if (!release?.draft) throw new Error("Release is no longer draft; retry to verify immutable public assets.");
		execute(["release", "upload", tag, ...files, sums, "--repo", options.repository, "--clobber"]);
		release = inspect(options, execute);
		if (!release?.draft) throw new Error("Release changed before promotion; retry without replacing public bytes.");
		execute([
			"release",
			"edit",
			tag,
			"--repo",
			options.repository,
			"--draft=false",
			`--prerelease=${options.version.includes("-")}`,
			"--title",
			tag,
			"--notes-file",
			options.notes,
		]);
	}
	await verifyPublic(options, options.publicDirectory);
}

async function main() {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			version: { type: "string" },
			sha: { type: "string" },
			repository: { type: "string" },
			dir: { type: "string" },
			"public-dir": { type: "string" },
			notes: { type: "string" },
		},
	});
	const options = { version: values.version, sourceSha: values.sha, repository: values.repository };
	identity(options);
	if (positionals[0] === "inspect") {
		const isPublic = findRelease(options)?.draft === false;
		if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
		await appendFile(process.env.GITHUB_OUTPUT, `public=${isPublic}\n`);
		return;
	}
	if (positionals[0] !== "publish" || !values.dir || !values["public-dir"] || !values.notes)
		throw new Error("Pass inspect|publish with exact release identity and publication paths.");
	await publishDesktopRelease({
		...options,
		directory: resolve(values.dir),
		publicDirectory: resolve(values["public-dir"]),
		notes: resolve(values.notes),
	});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
