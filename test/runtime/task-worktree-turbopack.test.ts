import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { repoUsesTurbopack } from "../../src/workspace/task-worktree-turbopack.js";
import { createTempDir } from "../utilities/temp-dir.js";

describe("repoUsesTurbopack", () => {
	it("detects --turbopack script flags", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-turbopack-detect-script-");
		try {
			const repoPath = join(sandboxRoot, "repo");
			mkdirSync(repoPath, { recursive: true });
			writeFileSync(
				join(repoPath, "package.json"),
				'{\n  "scripts": {\n    "dev": "next dev --turbopack"\n  }\n}\n',
				"utf8",
			);

			await expect(repoUsesTurbopack(repoPath)).resolves.toBe(true);
		} finally {
			cleanup();
		}
	});

	it("detects Turbopack env flag scripts", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-turbopack-detect-env-");
		try {
			const repoPath = join(sandboxRoot, "repo");
			mkdirSync(repoPath, { recursive: true });
			writeFileSync(
				join(repoPath, "package.json"),
				'{\n  "scripts": {\n    "dev": "TURBOPACK=true next dev"\n  }\n}\n',
				"utf8",
			);

			await expect(repoUsesTurbopack(repoPath)).resolves.toBe(true);
		} finally {
			cleanup();
		}
	});

	it("detects Turbopack keyword in next config", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-turbopack-detect-config-");
		try {
			const repoPath = join(sandboxRoot, "repo");
			mkdirSync(repoPath, { recursive: true });
			writeFileSync(join(repoPath, "package.json"), '{\n  "scripts": {\n    "dev": "next dev"\n  }\n}\n', "utf8");
			writeFileSync(join(repoPath, "next.config.js"), "export default { turbopack: {} };\n", "utf8");

			await expect(repoUsesTurbopack(repoPath)).resolves.toBe(true);
		} finally {
			cleanup();
		}
	});

	it("detects Turbopack in a nested app package", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-turbopack-detect-nested-app-");
		try {
			const repoPath = join(sandboxRoot, "repo");
			const appPath = join(repoPath, "apps", "web");
			mkdirSync(appPath, { recursive: true });
			writeFileSync(join(repoPath, "package.json"), '{\n  "private": true\n}\n', "utf8");
			writeFileSync(
				join(appPath, "package.json"),
				'{\n  "dependencies": {\n    "next": "15.0.0"\n  },\n  "scripts": {\n    "dev": "next dev --turbopack"\n  }\n}\n',
				"utf8",
			);

			await expect(repoUsesTurbopack(repoPath)).resolves.toBe(true);
		} finally {
			cleanup();
		}
	});

	it("detects Turbopack in a nested Next config", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-turbopack-detect-nested-config-");
		try {
			const repoPath = join(sandboxRoot, "repo");
			const appPath = join(repoPath, "apps", "web");
			mkdirSync(appPath, { recursive: true });
			writeFileSync(join(repoPath, "package.json"), '{\n  "private": true\n}\n', "utf8");
			writeFileSync(
				join(appPath, "package.json"),
				'{\n  "dependencies": {\n    "next": "15.0.0"\n  },\n  "scripts": {\n    "dev": "next dev"\n  }\n}\n',
				"utf8",
			);
			writeFileSync(join(appPath, "next.config.ts"), "export default { turbopack: {} };\n", "utf8");

			await expect(repoUsesTurbopack(repoPath)).resolves.toBe(true);
		} finally {
			cleanup();
		}
	});

	it("does not scan package directories deeper than the heuristic limit", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-turbopack-detect-too-deep-");
		try {
			const repoPath = join(sandboxRoot, "repo");
			const deepAppPath = join(repoPath, "packages", "clients", "web", "app");
			mkdirSync(deepAppPath, { recursive: true });
			writeFileSync(join(repoPath, "package.json"), '{\n  "private": true\n}\n', "utf8");
			writeFileSync(
				join(deepAppPath, "package.json"),
				'{\n  "dependencies": {\n    "next": "15.0.0"\n  },\n  "scripts": {\n    "dev": "next dev --turbopack"\n  }\n}\n',
				"utf8",
			);

			await expect(repoUsesTurbopack(repoPath)).resolves.toBe(false);
		} finally {
			cleanup();
		}
	});

	it("returns false when no Turbopack hints are present", async () => {
		const { path: sandboxRoot, cleanup } = createTempDir("kanban-turbopack-detect-none-");
		try {
			const repoPath = join(sandboxRoot, "repo");
			mkdirSync(repoPath, { recursive: true });
			writeFileSync(join(repoPath, "package.json"), '{\n  "scripts": {\n    "dev": "next dev"\n  }\n}\n', "utf8");

			await expect(repoUsesTurbopack(repoPath)).resolves.toBe(false);
		} finally {
			cleanup();
		}
	});
});
