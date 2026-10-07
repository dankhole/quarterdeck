import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Browser, Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	assertDesktopDebugEndpointUnchanged,
	observeDesktopRenderer,
	readDesktopDebugEndpoint,
} from "../../../scripts/agent-lab/desktop-reobserve";

describe("owned Electron renderer reobservation", () => {
	let root: string;
	let userDataPath: string;
	const valid = "9222\n/devtools/browser/11111111-1111-4111-8111-111111111111\n";
	beforeEach(async () => {
		root = await realpath(await mkdtemp(join(tmpdir(), "quarterdeck-desktop-reobserve-")));
		userDataPath = join(root, "user-data");
		await mkdir(userDataPath);
		await writeFile(join(userDataPath, "DevToolsActivePort"), valid);
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});
	it.each([
		"0\n/devtools/browser/11111111-1111-4111-8111-111111111111\n",
		"65536\n/devtools/browser/11111111-1111-4111-8111-111111111111\n",
		"9222\nws://foreign/browser/secret\n",
		"9222\n/devtools/page/11111111-1111-4111-8111-111111111111\n",
		"x".repeat(257),
	])("rejects malformed or oversized endpoint %s", async (contents) => {
		await writeFile(join(userDataPath, "DevToolsActivePort"), contents);
		await expect(readDesktopDebugEndpoint(userDataPath)).rejects.toThrow();
	});
	it("rejects a symlink endpoint", async () => {
		await rm(join(userDataPath, "DevToolsActivePort"));
		await writeFile(join(root, "foreign"), valid);
		await symlink(join(root, "foreign"), join(userDataPath, "DevToolsActivePort"));
		await expect(readDesktopDebugEndpoint(userDataPath)).rejects.toThrow();
	});
	it("rejects an endpoint changed since the original launch", async () => {
		const captured = await readDesktopDebugEndpoint(userDataPath);
		await writeFile(join(userDataPath, "DevToolsActivePort"), valid.replace("9222", "9223"));
		await expect(assertDesktopDebugEndpointUnchanged(captured)).rejects.toThrow("captured launch");
	});
	function browserWith(nonces: (string | undefined)[], contextCount = 1) {
		const pages = nonces.map(
			(nonce) =>
				({
					url: () => "app://quarterdeck/__desktop/error",
					evaluate: vi.fn(async () => nonce),
					setDefaultTimeout: vi.fn(),
					close: vi.fn(),
				}) as unknown as Page,
		);
		const context = { pages: () => pages, close: vi.fn() };
		const browser = {
			contexts: () => Array.from({ length: contextCount }, () => context),
			close: vi.fn(async () => {}),
		};
		return { browser: browser as unknown as Browser, close: browser.close, pages, context };
	}
	it("binds the original document without defaults and registers immediate cleanup", async () => {
		const candidate = browserWith(["nonce"]);
		const register = vi.fn();
		const connect = vi.fn(async () => candidate.browser);
		const owner = vi.fn(async () => {});
		const captured = await readDesktopDebugEndpoint(userDataPath);
		const result = await observeDesktopRenderer({
			capturedEndpoint: captured,
			artifactDir: root,
			nonce: "nonce",
			assertOriginalOwner: owner,
			registerObserver: register,
			connect,
		});
		expect(result.page).toBe(candidate.pages[0]);
		expect(connect).toHaveBeenCalledWith(captured.endpoint, {
			noDefaults: true,
			timeout: 10_000,
			artifactsDir: root,
		});
		expect(register).toHaveBeenCalledWith(candidate.browser);
		expect(owner).toHaveBeenCalledTimes(2);
		expect(candidate.close).not.toHaveBeenCalled();
	});
	it.each([{ nonces: [] }, { nonces: [undefined] }, { nonces: ["wrong"] }, { nonces: ["nonce", "nonce"] }])(
		"rejects absent/wrong/duplicate binding and detaches only observer %j",
		async ({ nonces }) => {
			const candidate = browserWith(nonces);
			const register = vi.fn();
			await expect(
				observeDesktopRenderer({
					capturedEndpoint: await readDesktopDebugEndpoint(userDataPath),
					artifactDir: root,
					nonce: "nonce",
					assertOriginalOwner: async () => {},
					registerObserver: register,
					connect: async () => candidate.browser,
				}),
			).rejects.toThrow("captured launch");
			expect(register).toHaveBeenCalledWith(candidate.browser);
			expect(candidate.close).toHaveBeenCalledOnce();
			expect(candidate.context.close).not.toHaveBeenCalled();
		},
	);
	it("rejects changed main or fixture before connecting", async () => {
		const connect = vi.fn();
		await expect(
			observeDesktopRenderer({
				capturedEndpoint: await readDesktopDebugEndpoint(userDataPath),
				artifactDir: root,
				nonce: "nonce",
				assertOriginalOwner: async () => {
					throw new Error("Owner changed");
				},
				registerObserver: vi.fn(),
				connect,
			}),
		).rejects.toThrow("Owner changed");
		expect(connect).not.toHaveBeenCalled();
	});
	it("detaches if ownership changes after connect", async () => {
		const candidate = browserWith(["nonce"]);
		const owner = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Changed owner"));
		await expect(
			observeDesktopRenderer({
				capturedEndpoint: await readDesktopDebugEndpoint(userDataPath),
				artifactDir: root,
				nonce: "nonce",
				assertOriginalOwner: owner,
				registerObserver: vi.fn(),
				connect: async () => candidate.browser,
			}),
		).rejects.toThrow("captured launch");
		expect(candidate.close).toHaveBeenCalledOnce();
	});
	it("does not expose a raw endpoint from a native connect timeout", async () => {
		await expect(
			observeDesktopRenderer({
				capturedEndpoint: await readDesktopDebugEndpoint(userDataPath),
				artifactDir: root,
				nonce: "nonce",
				assertOriginalOwner: async () => {},
				registerObserver: vi.fn(),
				connect: async () => {
					throw new Error(valid);
				},
			}),
		).rejects.toThrow("could not connect to the captured launch");
	});
});
