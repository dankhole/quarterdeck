import { describe, expect, it } from "vitest";
import { admittedBrowserLaunch } from "../src/browser-launch.js";

describe("private one-use browser action", () => {
	it("admits only the pinned endpoint's exact bootstrap capability", () => {
		const good = `http://127.0.0.1:12345/api/runtime/client-bootstrap?capability=${"a".repeat(43)}`;
		expect(admittedBrowserLaunch(good, "http://127.0.0.1:12345")).toBe(good);
		for (const value of [
			good.replace(":12345", ":12346"),
			good.replace("127.0.0.1", "localhost"),
			good.replace("client-bootstrap", "manage"),
			`${good}&extra=true`,
			`${good}#fragment`,
			good.replace("http://", "http://user@"),
			`${good}&capability=duplicate`,
		])
			expect(admittedBrowserLaunch(value, "http://127.0.0.1:12345")).toBeNull();
	});
});
