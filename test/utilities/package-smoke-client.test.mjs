import { describe, expect, it, vi } from "vitest";

import { fetchInstalledApplication, readInstalledBrowserBootstrap } from "../../scripts/package-smoke-client.mjs";

const capability = "synthetic-private-bootstrap";
const cookie = "quarterdeck_client_9d3b0c8d-3ef2-48bb-a6ae-cb0387cdbe0d=synthetic-private-cookie";
const bootstrap = `http://127.0.0.1:34567/api/runtime/client-bootstrap?capability=${capability}`;

function admission(location = "/projects/synthetic") {
	return new Response(null, {
		status: 303,
		headers: { Location: location, "Set-Cookie": `${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=60` },
	});
}

function application() {
	return new Response('<div id="root"></div>', { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

describe("installed package browser admission", () => {
	it("waits for the complete private Browser URL line, independently of the public runtime URL", () => {
		const output = "Quarterdeck running at http://127.0.0.1:34567/projects/synthetic\n";
		expect(readInstalledBrowserBootstrap(output)).toBeNull();
		expect(readInstalledBrowserBootstrap(`${output}Browser URL: ${bootstrap.slice(0, -8)}`)).toBeNull();
		expect(readInstalledBrowserBootstrap(`${output}Browser URL: ${bootstrap}`)).toBeNull();
		expect(readInstalledBrowserBootstrap(`${output}Browser URL: ${bootstrap}\n`)).toBe(bootstrap);
		expect(readInstalledBrowserBootstrap(`Browser URL: ${bootstrap}\r\n`)).toBe(bootstrap);
	});

	it("exchanges manually and sends only the issued cookie to the same-origin application", async () => {
		const request = vi.fn().mockResolvedValueOnce(admission()).mockResolvedValueOnce(application());
		await fetchInstalledApplication(bootstrap, { fetchImpl: request });
		expect(request).toHaveBeenNthCalledWith(1, bootstrap, expect.objectContaining({ redirect: "manual" }));
		expect(request).toHaveBeenNthCalledWith(
			2,
			"http://127.0.0.1:34567/projects/synthetic",
			expect.objectContaining({ redirect: "manual", headers: { Cookie: cookie } }),
		);
	});

	it.each([
		"https://127.0.0.1:34567/",
		"http://127.0.0.1:34568/",
		"http://localhost:34567/",
		"//example.invalid/",
		"http://user:secret@127.0.0.1:34567/",
	])(
		"rejects changed origin or URL credentials before forwarding a cookie: %s",
		async (location) => {
			const request = vi.fn().mockResolvedValueOnce(admission(location));
			await expect(fetchInstalledApplication(bootstrap, { fetchImpl: request })).rejects.toThrow("outside its application origin");
			expect(request).toHaveBeenCalledTimes(1);
		},
	);

	it("rejects an automatic-follow response instead of treating it as admission", async () => {
		const request = vi.fn().mockResolvedValueOnce(application());
		await expect(fetchInstalledApplication(bootstrap, { fetchImpl: request })).rejects.toThrow("admission returned HTTP 200");
		expect(request).toHaveBeenCalledTimes(1);
	});

	it.each([
		`${cookie}; SameSite=Strict; Path=/`,
		`${cookie}; HttpOnly; SameSite=Strict; Path=/; Domain=127.0.0.1`,
		"unrelated=synthetic-private-cookie; HttpOnly; SameSite=Strict; Path=/",
	])("rejects an unexpected cookie without exposing its value", async (issuedCookie) => {
		const response = admission();
		response.headers.set("Set-Cookie", issuedCookie);
		const request = vi.fn().mockResolvedValueOnce(response);
		await expect(fetchInstalledApplication(bootstrap, { fetchImpl: request })).rejects.toThrow("expected private browser cookie");
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("does not follow a second redirect with the authenticated cookie", async () => {
		const request = vi.fn().mockResolvedValueOnce(admission()).mockResolvedValueOnce(
			new Response(null, { status: 302, headers: { Location: "https://example.invalid/" } }),
		);
		await expect(fetchInstalledApplication(bootstrap, { fetchImpl: request })).rejects.toThrow("HTTP 302");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it.each([0, 1])("redacts request failures at request %s", async (failingRequest) => {
		const request = vi.fn();
		if (failingRequest === 1) request.mockResolvedValueOnce(admission());
		request.mockRejectedValueOnce(new Error(`${bootstrap} Cookie: ${cookie}`));
		await expect(fetchInstalledApplication(bootstrap, { fetchImpl: request })).rejects.toMatchObject({
			message: "Installed CLI browser request failed.",
		});
	});

	it("redacts malformed bootstrap addresses before making a request", async () => {
		const request = vi.fn();
		await expect(fetchInstalledApplication(`invalid:${capability}`, { fetchImpl: request })).rejects.toMatchObject({
			message: "Installed CLI supplied an invalid browser bootstrap address.",
		});
		expect(request).not.toHaveBeenCalled();
	});

	it("rejects multiple issued cookies before sending any credentials", async () => {
		const response = admission();
		response.headers.append("Set-Cookie", "other=synthetic; HttpOnly; Path=/");
		const request = vi.fn().mockResolvedValueOnce(response);
		await expect(fetchInstalledApplication(bootstrap, { fetchImpl: request })).rejects.toThrow("one private browser cookie");
		expect(request).toHaveBeenCalledTimes(1);
	});
});
