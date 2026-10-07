/** Wait for a complete stdout line so a chunk boundary cannot truncate a capability. */
export function readInstalledBrowserBootstrap(stdout) {
	return stdout.match(/(?:^|\n)Browser URL: (http:\/\/127\.0\.0\.1:\d+[^\s]+)\r?\n/u)?.[1] ?? null;
}

function bootstrapAddress(runtimeUrl) {
	let address;
	try {
		address = new URL(runtimeUrl);
	} catch {
		throw new Error("Installed CLI supplied an invalid browser bootstrap address.");
	}
	if (
		address.protocol !== "http:" ||
		address.hostname !== "127.0.0.1" ||
		address.username ||
		address.password ||
		address.hash ||
		address.pathname !== "/api/runtime/client-bootstrap" ||
		address.searchParams.getAll("capability").length !== 1 ||
		!address.searchParams.get("capability") ||
		[...address.searchParams.keys()].some((key) => key !== "capability")
	) {
		throw new Error("Installed CLI supplied an invalid browser bootstrap address.");
	}
	return address;
}

function clientCookie(headers) {
	const cookies = headers.getSetCookie();
	if (cookies.length !== 1) throw new Error("Installed CLI did not issue one private browser cookie.");
	const [cookie, ...attributes] = cookies[0].split(";").map((part) => part.trim());
	const flags = new Set(attributes.map((attribute) => attribute.toLowerCase()));
	if (
		!/^quarterdeck_client_[\da-f-]{36}=[\w-]+$/u.test(cookie) ||
		!flags.has("httponly") ||
		!flags.has("samesite=strict") ||
		!flags.has("path=/") ||
		attributes.some((attribute) => /^domain\s*=/iu.test(attribute))
	) {
		throw new Error("Installed CLI did not issue the expected private browser cookie.");
	}
	return cookie;
}

async function request(url, options, fetchImpl) {
	try {
		return await fetchImpl(url, options);
	} catch {
		// Fetch errors can contain a one-use URL or request headers.
		throw new Error("Installed CLI browser request failed.");
	}
}

/** Exchange one CLI capability without a cookie jar or automatic redirects. */
export async function fetchInstalledApplication(runtimeUrl, { timeoutMs = 15_000, fetchImpl = fetch } = {}) {
	const bootstrap = bootstrapAddress(runtimeUrl);
	const signal = AbortSignal.timeout(timeoutMs);
	const admission = await request(bootstrap.href, { redirect: "manual", signal }, fetchImpl);
	if (admission.status !== 303) {
		throw new Error(`Installed CLI browser admission returned HTTP ${admission.status}.`);
	}
	let destination;
	try {
		const location = admission.headers.get("location");
		if (!location) throw new Error();
		destination = new URL(location, bootstrap);
	} catch {
		throw new Error("Installed CLI browser admission supplied an invalid redirect.");
	}
	if (
		destination.origin !== bootstrap.origin ||
		destination.username ||
		destination.password ||
		destination.pathname.startsWith("/api/")
	) {
		throw new Error("Installed CLI browser admission redirected outside its application origin.");
	}
	const cookie = clientCookie(admission.headers);
	const response = await request(
		destination.href,
		{ redirect: "manual", signal, headers: { Cookie: cookie } },
		fetchImpl,
	);
	if (!response.ok) throw new Error(`Installed CLI returned HTTP ${response.status} for its application document.`);
	if (!(response.headers.get("content-type") ?? "").startsWith("text/html")) {
		throw new Error("Installed CLI application URL did not return an HTML document.");
	}
	let document;
	try {
		document = await response.text();
	} catch {
		throw new Error("Installed CLI application document could not be read.");
	}
	if (!document.includes('<div id="root"></div>')) {
		throw new Error("Installed CLI application URL did not return the bundled Quarterdeck application shell.");
	}
}
