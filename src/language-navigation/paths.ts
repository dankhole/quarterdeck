import { access, constants } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Location, LocationLink } from "vscode-languageserver-protocol";
import {
	type CodeNavigationLocation,
	codeNavigationRangeSchema,
	type LspServerConfig,
} from "../core/api/code-navigation";
import { areFileSystemPathsEqual, isFileSystemPathWithin } from "../core/path-comparison";
import { openWorkdirFile } from "../workdir/read-workdir-file";
import { normalizeWorkdirRelativePath } from "../workdir/workdir-path-policy";

export function selectLanguageServer(servers: LspServerConfig[], filePath: string): LspServerConfig | undefined {
	const extension = extname(filePath).toLowerCase();
	return servers.find(
		(server) => server.enabled && server.extensions.some((value) => value.toLowerCase() === extension),
	);
}

export async function resolveLanguageRoot(scopeRoot: string, filePath: string, markers: string[]): Promise<string> {
	let candidate = dirname(filePath);
	while (isFileSystemPathWithin(scopeRoot, candidate)) {
		for (const marker of markers) {
			try {
				await access(resolve(candidate, marker), constants.F_OK);
				return candidate;
			} catch {
				/* Try the next marker. */
			}
		}
		if (areFileSystemPathsEqual(candidate, scopeRoot)) break;
		candidate = dirname(candidate);
	}
	return scopeRoot;
}

export async function mapNavigationLocations(
	scopeRoot: string,
	value: Location | Array<Location | LocationLink> | null,
	limit = 500,
): Promise<{ locations: CodeNavigationLocation[]; truncated: boolean }> {
	const raw = value === null ? [] : Array.isArray(value) ? value : [value];
	const locations: CodeNavigationLocation[] = [];
	const seen = new Set<string>();
	// Bound server-controlled filesystem work as well as the UI result count.
	for (const location of raw.slice(0, limit)) {
		try {
			const uri = "targetUri" in location ? location.targetUri : location.uri;
			const range = codeNavigationRangeSchema.parse(
				"targetSelectionRange" in location ? location.targetSelectionRange : location.range,
			);
			const url = new URL(uri);
			if (url.protocol !== "file:") continue;
			const targetPath = fileURLToPath(url);
			if (!isFileSystemPathWithin(scopeRoot, targetPath)) continue;
			const path = normalizeWorkdirRelativePath(relative(scopeRoot, targetPath));
			const opened = await openWorkdirFile(scopeRoot, path);
			await opened.fileHandle.close();
			const key = JSON.stringify([path, range]);
			if (!seen.has(key)) {
				seen.add(key);
				locations.push({ path, range });
			}
		} catch {
			/* Unsupported, missing, or escaped server results are not navigable. */
		}
	}
	return { locations, truncated: raw.length > limit };
}

export function languageIdForPath(filePath: string): string {
	const extension = extname(filePath).slice(1).toLowerCase();
	const languageIds: Record<string, string> = {
		ts: "typescript",
		mts: "typescript",
		cts: "typescript",
		tsx: "typescriptreact",
		js: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		jsx: "javascriptreact",
		py: "python",
		pyi: "python",
		rs: "rust",
		go: "go",
		c: "c",
		h: "c",
		cpp: "cpp",
		cc: "cpp",
		hpp: "cpp",
	};
	return languageIds[extension] ?? extension;
}
