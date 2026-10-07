import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	desktopChildMessageSchema,
	desktopRuntimeOriginSchema,
	desktopStartupMessageSchema,
} from "../../../src/core/api/desktop-runtime-protocol.js";

describe("private desktop runtime protocol", () => {
	it.each([
		"https://127.0.0.1:3500",
		"http://localhost:3500",
		"http://127.0.0.2:3500",
		"http://127.0.0.1:3500/",
		"http://127.0.0.1:3500?token=secret",
		"http://token@127.0.0.1:3500",
		"http://127.0.0.1",
		"http://127.0.0.1:80",
	])("rejects noncanonical or credential-bearing runtime origin %s", (origin) => {
		expect(desktopRuntimeOriginSchema.safeParse(origin).success).toBe(false);
	});
	it("admits only the private capability and exact desktop origin", () => {
		const startup = {
			type: "quarterdeck:desktop-startup",
			protocolVersion: 1,
			startupId: randomUUID(),
			clientToken: "a".repeat(43),
			allowedOrigins: ["app://quarterdeck"],
		};
		expect(desktopStartupMessageSchema.safeParse(startup).success).toBe(true);
		expect(
			desktopStartupMessageSchema.safeParse({ ...startup, allowedOrigins: ["https://example.com"] }).success,
		).toBe(false);
		expect(desktopStartupMessageSchema.safeParse({ ...startup, command: "open" }).success).toBe(false);
	});
	it("cannot label deadline-limited shutdown as permission to exit", () => {
		const message = {
			type: "quarterdeck:desktop-shutdown-result",
			protocolVersion: 1,
			startupId: randomUUID(),
			requestId: randomUUID(),
			outcome: { status: "incomplete", safeToExit: false, safeToReleaseOwnership: false, reasons: ["deadline"] },
		};
		expect(desktopChildMessageSchema.safeParse(message).success).toBe(true);
		expect(
			desktopChildMessageSchema.safeParse({ ...message, outcome: { ...message.outcome, safeToExit: true } }).success,
		).toBe(false);
	});
});
