import { afterEach, describe, expect, it, vi } from "vitest";
import {
	checkForDesktopUpdate,
	DesktopUpdateCheckError,
	isDesktopUpdateTarget,
} from "../../../src/desktop-update/check.js";

function metadata(version = "1.3.0", channel = "latest") {
	return {
		name: "quarterdeck",
		"dist-tags": { [channel]: version },
		versions: { [version]: { name: "quarterdeck", version } },
	};
}

function transport(value: unknown) {
	return vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(value));
}

afterEach(() => vi.useRealTimers());

describe("desktop update registry discovery", () => {
	it.each([
		["1.2.0", "1.3.0", true],
		["1.2.0", "v1.3.0", false],
		["1.2", "1.3.0", false],
		["1.3.0+old", "1.3.0+new", false],
		["1.2.0", "1.3.0+new", false],
		["1.3.0", "1.2.0", false],
		["1.3.0-preview.9", "1.3.0-preview.10", true],
		["1.3.0-preview.1", "1.3.0", false],
		["1.3.0", "1.4.0-preview.1", false],
	])("revalidates the exact handoff target %s -> %s", (installed, target, valid) => {
		expect(isDesktopUpdateTarget(installed, target)).toBe(valid);
	});

	it("uses only the fixed public registry without credentials or redirect following", async () => {
		const fetch = transport(metadata());
		await expect(checkForDesktopUpdate("1.2.0", { fetch })).resolves.toEqual({
			channel: "latest",
			availableVersion: "1.3.0",
		});
		expect(fetch).toHaveBeenCalledExactlyOnceWith("https://registry.npmjs.org/quarterdeck", {
			method: "GET",
			redirect: "manual",
			credentials: "omit",
			signal: expect.any(AbortSignal),
			headers: { Accept: "application/vnd.npm.install-v1+json" },
		});
	});

	it.each([
		["1.2.9", "1.2.10", "1.2.10"],
		["1.2.10", "1.2.9", null],
		["1.3.0", "1.3.0", null],
		["2.0.0", "1.99.99", null],
	])("compares stable %s with %s using semantic precedence", async (installed, target, availableVersion) => {
		await expect(checkForDesktopUpdate(installed, { fetch: transport(metadata(target)) })).resolves.toEqual({
			channel: "latest",
			availableVersion,
		});
	});

	it.each([
		["1.3.0-preview.9", "1.3.0-preview.10", "1.3.0-preview.10"],
		["1.3.0-preview.10", "1.3.0-preview.9", null],
		["1.3.0-beta.1", "1.3.0-rc.1", "1.3.0-rc.1"],
		["1.3.0-rc.1", "1.3.0-rc.1", null],
		["1.4.0-preview.1", "1.3.0-preview.99", null],
	])("compares prerelease %s with %s on preview", async (installed, target, availableVersion) => {
		await expect(
			checkForDesktopUpdate(installed, { fetch: transport(metadata(target, "preview")) }),
		).resolves.toEqual({
			channel: "preview",
			availableVersion,
		});
	});

	it.each(["1.2", "v1.2.3", " 1.2.3", "1.2.3 ", "1.2.3-01", "1.2.3;echo secret", "1.2.3+build", "x".repeat(97)])(
		"rejects invalid installed version %s before network access",
		async (version) => {
			const fetch = transport(metadata());
			await expect(checkForDesktopUpdate(version, { fetch })).rejects.toMatchObject({
				code: "invalid_installed_version",
			});
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it.each([
		null,
		[],
		{ ...metadata(), name: "other-package" },
		{ ...metadata(), "dist-tags": {} },
		{ ...metadata(), "dist-tags": { latest: "v1.3.0" } },
		{ ...metadata(), "dist-tags": { latest: "1.3" } },
		{ ...metadata(), "dist-tags": { latest: 130 } },
		{ ...metadata(), versions: {} },
		{ ...metadata(), versions: { "1.3.0": { name: "other-package", version: "1.3.0" } } },
		{ ...metadata(), versions: { "1.3.0": { name: "quarterdeck", version: "1.3.1" } } },
		{ ...metadata(), versions: { "1.3.0": null } },
		metadata("1.3.0-preview.1"),
		metadata("1.3.0+build"),
	])("rejects malformed or mismatched release metadata %#", async (value) => {
		await expect(checkForDesktopUpdate("1.2.0", { fetch: transport(value) })).rejects.toMatchObject({
			code: "invalid_registry_response",
		});
	});

	it("requires preview metadata for prerelease installations without falling back to latest", async () => {
		await expect(checkForDesktopUpdate("1.3.0-preview.1", { fetch: transport(metadata()) })).rejects.toMatchObject({
			code: "invalid_registry_response",
		});
		await expect(
			checkForDesktopUpdate("1.3.0-preview.1", { fetch: transport(metadata("1.3.0", "preview")) }),
		).rejects.toMatchObject({ code: "invalid_registry_response" });
		await expect(
			checkForDesktopUpdate("1.3.0-preview.1", { fetch: transport(metadata("1.3.0-preview.2+build", "preview")) }),
		).rejects.toMatchObject({ code: "invalid_registry_response" });
	});

	it.each([301, 302, 303, 307, 308, 404, 500])("rejects HTTP %s without following redirects", async (status) => {
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
			new Response("private registry error", {
				status,
				headers: { location: "https://attacker.invalid/?credential=secret" },
			}),
		);
		await expect(checkForDesktopUpdate("1.2.0", { fetch })).rejects.toMatchObject({
			code: "invalid_registry_response",
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ url: "https://attacker.invalid/quarterdeck" },
		{ url: "https://user:secret@registry.npmjs.org/quarterdeck" },
		{ url: "https://registry.npmjs.org/quarterdeck", redirected: true },
	])("refuses a transport that already followed a redirect %#", async (properties) => {
		const response = Response.json(metadata());
		for (const [key, value] of Object.entries(properties)) Object.defineProperty(response, key, { value });
		await expect(
			checkForDesktopUpdate("1.2.0", { fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response) }),
		).rejects.toMatchObject({ code: "invalid_registry_response" });
	});

	it("sanitizes thrown network failures", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockRejectedValue(new Error("https://user:secret@private.example/"));
		const error = await checkForDesktopUpdate("1.2.0", { fetch }).catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(DesktopUpdateCheckError);
		expect(error).toMatchObject({ code: "network_failed" });
		expect(String(error)).not.toMatch(/secret|private\.example/u);
		expect(error).not.toHaveProperty("cause");
	});

	it("sanitizes failures while consuming the registry body", async () => {
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.error(new Error("registry response contains secret credentials"));
				},
			}),
		);
		const failure = await checkForDesktopUpdate("1.2.0", {
			fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response),
		}).catch((error: unknown) => error);
		expect(failure).toMatchObject({ code: "network_failed" });
		expect(String(failure)).not.toContain("secret");
	});

	it("rejects a missing registry body", async () => {
		await expect(
			checkForDesktopUpdate("1.2.0", {
				fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null)),
			}),
		).rejects.toMatchObject({ code: "invalid_registry_response" });
	});

	it.each(["{secret", "", "null"])("rejects malformed JSON or metadata %s", async (body) => {
		await expect(
			checkForDesktopUpdate("1.2.0", {
				fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body)),
			}),
		).rejects.toMatchObject({ code: "invalid_registry_response" });
	});

	it.each(["900", "not-a-number", "-1"])("rejects oversized or invalid content length %s", async (length) => {
		const response = Response.json(metadata(), { headers: { "content-length": length } });
		await expect(
			checkForDesktopUpdate("1.2.0", {
				fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response),
				maxResponseBytes: 512,
			}),
		).rejects.toMatchObject({ code: "invalid_registry_response" });
	});

	it("bounds actual streamed bytes even with a false small content length", async () => {
		const cancel = vi.fn();
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(100));
					controller.enqueue(new Uint8Array(100));
				},
				cancel,
			}),
			{ headers: { "content-length": "1" } },
		);
		await expect(
			checkForDesktopUpdate("1.2.0", {
				fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response),
				maxResponseBytes: 150,
			}),
		).rejects.toMatchObject({ code: "invalid_registry_response" });
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("bounds a fetch even when the injected transport ignores abort", async () => {
		vi.useFakeTimers();
		const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise(() => undefined));
		const check = checkForDesktopUpdate("1.2.0", { fetch, timeoutMs: 20 });
		const rejected = expect(check).rejects.toMatchObject({ code: "timed_out" });
		await vi.advanceTimersByTimeAsync(20);
		await rejected;
		expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
	});

	it("keeps the deadline active while the body stalls and does not await cancellation", async () => {
		vi.useFakeTimers();
		const cancel = vi.fn(() => new Promise<void>(() => undefined));
		const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
		const check = checkForDesktopUpdate("1.2.0", {
			fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response),
			timeoutMs: 20,
		});
		const rejected = expect(check).rejects.toMatchObject({ code: "timed_out" });
		await vi.advanceTimersByTimeAsync(20);
		await rejected;
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("cancels a response that arrives after the deadline", async () => {
		vi.useFakeTimers();
		let resolveResponse: ((response: Response) => void) | undefined;
		const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
			() =>
				new Promise<Response>((resolve) => {
					resolveResponse = resolve;
				}),
		);
		const check = checkForDesktopUpdate("1.2.0", { fetch, timeoutMs: 20 });
		const rejected = expect(check).rejects.toMatchObject({ code: "timed_out" });
		await vi.advanceTimersByTimeAsync(20);
		await rejected;
		const cancel = vi.fn();
		resolveResponse?.(new Response(new ReadableStream<Uint8Array>({ cancel })));
		await vi.advanceTimersByTimeAsync(0);
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ timeoutMs: 10_001 },
		{ timeoutMs: 0 },
		{ maxResponseBytes: 2_097_153 },
		{ maxResponseBytes: Number.NaN },
	])("never extends production bounds %#", async (options) => {
		const fetch = transport(metadata());
		await expect(checkForDesktopUpdate("1.2.0", { ...options, fetch })).rejects.toMatchObject({
			code: "invalid_options",
		});
		expect(fetch).not.toHaveBeenCalled();
	});
});
