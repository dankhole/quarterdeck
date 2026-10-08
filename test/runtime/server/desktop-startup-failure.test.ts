import { describe, expect, it } from "vitest";
import { classifyDesktopStartupFailure } from "../../../src/server/desktop-startup-failure.js";
import { RuntimeOwnerConnectionError } from "../../../src/server/runtime-owner-client.js";
import { RuntimeOwnershipError } from "../../../src/server/runtime-ownership.js";
import { RuntimeRecoveryAdmissionError } from "../../../src/server/runtime-recovery-admission.js";

describe("desktop startup guidance", () => {
	it("offers explicit recovery for unconfirmed custody without exposing process evidence", () => {
		const failure = classifyDesktopStartupFailure(
			new RuntimeRecoveryAdmissionError("unconfirmed_prior_custody", [54321]),
		);
		expect(failure.code).toBe("recovery_custody_unconfirmed");
		expect(failure.message).toContain("quarterdeck recover");
		expect(failure.message).not.toContain("54321");
	});
	it("distinguishes live processes, unavailable identity, and incompatible owners", () => {
		expect(classifyDesktopStartupFailure(new RuntimeRecoveryAdmissionError("live_prior_process")).code).toBe(
			"prior_processes_live",
		);
		expect(classifyDesktopStartupFailure(new RuntimeOwnershipError("identity_unavailable", "sensitive")).code).toBe(
			"identity_unavailable",
		);
		expect(
			classifyDesktopStartupFailure(new RuntimeOwnerConnectionError("incompatible_runtime", "sensitive")).code,
		).toBe("incompatible_runtime");
	});
	it("never forwards raw errors to a startup view", () => {
		for (const error of [
			new Error("secret command output"),
			new RuntimeOwnershipError("invalid_claim", "/private/user/state"),
			new RuntimeRecoveryAdmissionError("unverifiable_evidence"),
		]) {
			const failure = classifyDesktopStartupFailure(error);
			expect(failure.message).not.toMatch(/secret|\/private\/user/);
		}
	});
});
