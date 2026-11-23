import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadNode } from "../scripts/stage-runtime.mjs";

const { delay } = vi.hoisted(() => ({ delay: vi.fn().mockResolvedValue(undefined) }));
vi.mock("node:timers/promises", () => ({ setTimeout: delay }));

const fetchArchive = vi.fn();
const bytes = Buffer.from("synthetic Node archive");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const nodeVersion = "22.22.2";
const packageMetadata = {
	quarterdeckDesktop: { nodeVersion, nodeArchives: { x64: sha256 }, windowsNodeArchives: { x64: sha256 } },
};
const filename = `node-v${nodeVersion}-${process.platform === "win32" ? "win-x64.zip" : "darwin-x64.tar.gz"}`;
const transportError = (code) => new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
let root;
let cache;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "qdeck-stage-runtime-"));
	cache = join(root, "cache");
	vi.stubGlobal("fetch", fetchArchive.mockReset());
	vi.spyOn(console, "warn").mockImplementation(() => {});
	delay.mockClear();
});

afterEach(async () => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

describe("pinned bundled Node archive", () => {
	it("recovers from connect and body transport failures and caches only verified bytes", async () => {
		fetchArchive
			.mockRejectedValueOnce(transportError("UND_ERR_CONNECT_TIMEOUT"))
			.mockResolvedValueOnce({
				ok: true,
				arrayBuffer: async () => {
					throw transportError("UND_ERR_BODY_TIMEOUT");
				},
			})
			.mockImplementationOnce(async () => {
				expect(await readdir(cache)).toEqual([]);
				return new Response(bytes);
			});

		const archive = join(cache, filename);
		await expect(downloadNode(packageMetadata, "x64", cache)).resolves.toEqual({
			archive,
			filename,
			nodeVersion,
			sha256,
		});
		expect(fetchArchive).toHaveBeenCalledTimes(3);
		expect(fetchArchive).toHaveBeenCalledWith(`https://nodejs.org/dist/v${nodeVersion}/${filename}`);
		expect(await readdir(cache)).toEqual([filename]);
		expect(await readFile(archive)).toEqual(bytes);

		// Subsequent staging verifies the cache and does not need the network.
		await expect(downloadNode(packageMetadata, "x64", cache)).resolves.toHaveProperty("archive", archive);
		expect(fetchArchive).toHaveBeenCalledTimes(3);
	});

	it("stops after three transport failures, preserving the last error", async () => {
		const lastError = transportError("ETIMEDOUT");
		fetchArchive
			.mockRejectedValueOnce(transportError("ECONNRESET"))
			.mockRejectedValueOnce(transportError("UND_ERR_CONNECT_TIMEOUT"))
			.mockRejectedValueOnce(lastError);

		await expect(downloadNode(packageMetadata, "x64", cache)).rejects.toBe(lastError);
		expect(fetchArchive).toHaveBeenCalledTimes(3);
		expect(delay.mock.calls).toEqual([[500], [1000]]);
		expect(await readdir(cache)).toEqual([]);
	});

	it("does not retry HTTP or certificate failures", async () => {
		fetchArchive.mockResolvedValueOnce(new Response(null, { status: 503 }));
		await expect(downloadNode(packageMetadata, "x64", cache)).rejects.toThrow("HTTP 503");
		expect(fetchArchive).toHaveBeenCalledTimes(1);

		const certError = transportError("CERT_HAS_EXPIRED");
		fetchArchive.mockRejectedValueOnce(certError);
		await expect(downloadNode(packageMetadata, "x64", cache)).rejects.toBe(certError);
		expect(fetchArchive).toHaveBeenCalledTimes(2);
		expect(delay).not.toHaveBeenCalled();
	});

	it("never retries or publishes a download with a bad checksum", async () => {
		fetchArchive.mockResolvedValueOnce(new Response("corrupt download"));

		await expect(downloadNode(packageMetadata, "x64", cache)).rejects.toThrow("checksum mismatch");
		expect(fetchArchive).toHaveBeenCalledTimes(1);
		expect(delay).not.toHaveBeenCalled();
		expect(await readdir(cache)).toEqual([]);
	});

	it("verifies cached bytes and fails closed without re-downloading if they differ", async () => {
		await mkdir(cache);
		const archive = join(cache, filename);
		await writeFile(archive, "corrupt cache");

		await expect(downloadNode(packageMetadata, "x64", cache)).rejects.toThrow("checksum mismatch");
		expect(fetchArchive).not.toHaveBeenCalled();
		expect(await readFile(archive, "utf8")).toBe("corrupt cache");
	});
});
