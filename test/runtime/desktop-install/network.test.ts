import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadDesktopAsset } from "../../../src/desktop-install/network.js";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "quarterdeck-asset-download-test-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});
const url = "https://github.com/dankhole/quarterdeck/releases/download/v0.12.8/artifact-manifest-darwin-arm64.json";

describe("bounded desktop asset download", () => {
	it("follows an approved HTTPS asset redirect with a bounded body", async () => {
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: { location: "https://release-assets.githubusercontent.com/asset?signature=synthetic" },
				}),
			)
			.mockResolvedValueOnce(new Response("verified payload"));
		const destination = join(root, "payload");
		await downloadDesktopAsset(url, destination, 128, request);
		expect(await readFile(destination, "utf8")).toBe("verified payload");
		expect(request.mock.calls).toHaveLength(2);
		expect(request.mock.calls[0]?.[1]?.redirect).toBe("manual");
	});

	it.each([
		"http://release-assets.githubusercontent.com/a",
		"https://evil.example/a",
		"https://github.com:444/a",
		"https://user:password@github.com/a",
	])("rejects unsafe redirect %s before requesting it", async (location) => {
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
		await expect(downloadDesktopAsset(url, join(root, "payload"), 128, request)).rejects.toThrow(
			"approved HTTPS asset hosts",
		);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("returns actionable unpublished-release guidance without requesting a newer version", async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
		await expect(downloadDesktopAsset(url, join(root, "payload"), 128, request)).rejects.toThrow(
			"--from /path/to/Quarterdeck.app",
		);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("rejects an advertised oversized response before opening a destination", async () => {
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response("huge", { headers: { "content-length": "10000" } }));
		await expect(downloadDesktopAsset(url, join(root, "payload"), 10, request)).rejects.toThrow("size limit");
		await expect(readFile(join(root, "payload"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("bounds streamed bytes when Content-Length is absent", async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("12345678901"));
		await expect(downloadDesktopAsset(url, join(root, "payload"), 10, request)).rejects.toThrow("size limit");
		expect((await readFile(join(root, "payload"))).length).toBe(0);
	});

	it("bounds the redirect chain", async () => {
		const request = vi
			.fn<typeof fetch>()
			.mockImplementation(async () => new Response(null, { status: 302, headers: { location: url } }));
		await expect(downloadDesktopAsset(url, join(root, "payload"), 128, request)).rejects.toThrow("too many");
		expect(request).toHaveBeenCalledTimes(5);
	});

	it("cancels the response if a destination already exists and never overwrites it", async () => {
		const cancel = vi.fn();
		const stream = new ReadableStream<Uint8Array>({ cancel });
		const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
		const destination = join(root, "payload");
		await writeFile(destination, "existing bytes");
		await expect(downloadDesktopAsset(url, destination, 128, request)).rejects.toMatchObject({ code: "EEXIST" });
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(await readFile(destination, "utf8")).toBe("existing bytes");
	});

	it("returns bounded network guidance without exposing transport error text", async () => {
		const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("synthetic sensitive transport details"));
		await expect(downloadDesktopAsset(url, join(root, "payload"), 128, request)).rejects.toMatchObject({
			code: "download_failed",
			message: expect.stringContaining("Check network access"),
		});
		await expect(readFile(join(root, "payload"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});
