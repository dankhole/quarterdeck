import { afterEach, describe, expect, it } from "vitest";

import {
	buildQuarterdeckRuntimeUrl,
	buildQuarterdeckRuntimeWsUrl,
	DEFAULT_QUARTERDECK_RUNTIME_PORT,
	getQuarterdeckRuntimeHost,
	getQuarterdeckRuntimePort,
	parseRuntimePort,
	setQuarterdeckRuntimeHost,
	setQuarterdeckRuntimePort,
} from "../../src/core/runtime-endpoint";

const originalRuntimePort = getQuarterdeckRuntimePort();
const originalRuntimeHost = getQuarterdeckRuntimeHost();
const originalEnvPort = process.env.QUARTERDECK_RUNTIME_PORT;
const originalEnvHost = process.env.QUARTERDECK_RUNTIME_HOST;

afterEach(() => {
	setQuarterdeckRuntimePort(originalRuntimePort);
	setQuarterdeckRuntimeHost(originalRuntimeHost);
	if (originalEnvPort === undefined) {
		delete process.env.QUARTERDECK_RUNTIME_PORT;
	} else {
		process.env.QUARTERDECK_RUNTIME_PORT = originalEnvPort;
	}
	if (originalEnvHost === undefined) {
		delete process.env.QUARTERDECK_RUNTIME_HOST;
	} else {
		process.env.QUARTERDECK_RUNTIME_HOST = originalEnvHost;
	}
});

describe("runtime-endpoint", () => {
	it("parses default port when env value is missing", () => {
		expect(parseRuntimePort(undefined)).toBe(DEFAULT_QUARTERDECK_RUNTIME_PORT);
	});

	it("throws for invalid ports", () => {
		expect(() => parseRuntimePort("0")).toThrow(/Invalid QUARTERDECK_RUNTIME_PORT value/);
		expect(() => parseRuntimePort("70000")).toThrow(/Invalid QUARTERDECK_RUNTIME_PORT value/);
		expect(() => parseRuntimePort("abc")).toThrow(/Invalid QUARTERDECK_RUNTIME_PORT value/);
	});

	it("updates runtime url builders when port changes", () => {
		setQuarterdeckRuntimePort(4567);
		expect(getQuarterdeckRuntimePort()).toBe(4567);
		expect(process.env.QUARTERDECK_RUNTIME_PORT).toBe("4567");
		expect(buildQuarterdeckRuntimeUrl("/api/trpc")).toBe("http://127.0.0.1:4567/api/trpc");
		expect(buildQuarterdeckRuntimeWsUrl("api/terminal/ws")).toBe("ws://127.0.0.1:4567/api/terminal/ws");
	});

	it("updates runtime url builders when host changes", () => {
		setQuarterdeckRuntimeHost("100.64.0.1");
		setQuarterdeckRuntimePort(4567);
		expect(getQuarterdeckRuntimeHost()).toBe("100.64.0.1");
		expect(process.env.QUARTERDECK_RUNTIME_HOST).toBe("100.64.0.1");
		expect(buildQuarterdeckRuntimeUrl("/api/trpc")).toBe("http://100.64.0.1:4567/api/trpc");
		expect(buildQuarterdeckRuntimeWsUrl("api/terminal/ws")).toBe("ws://100.64.0.1:4567/api/terminal/ws");
	});

	it("defaults host to 127.0.0.1", () => {
		expect(getQuarterdeckRuntimeHost()).toBe("127.0.0.1");
	});
});
