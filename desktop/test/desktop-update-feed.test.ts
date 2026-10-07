import { describe, expect, it } from "vitest";
import { canonicalDesktopValidationFeedBase } from "../src/desktop-update-feed.js";

describe("signed validation feed URL policy", () => {
	it("canonicalizes only trailing slashes on an HTTPS feed base", () => {
		for (const value of [
			"https://updates.example/quarterdeck",
			"https://updates.example/quarterdeck/",
			"https://updates.example/quarterdeck///",
		])
			expect(canonicalDesktopValidationFeedBase(value)).toBe("https://updates.example/quarterdeck/");
	});
	it.each([
		"http://updates.example/",
		"https://user:password@updates.example/",
		"https://updates.example/?token=secret",
		"https://updates.example/#fragment",
		"https://updates.example/?",
		"https://updates.example/#",
		"https://Updates.example/",
		"https://updates.example:443/",
		"https://updates.example/a/../b",
		"https://update.electronjs.org/dankhole/quarterdeck/",
		"https://update.electronjs.org/another/repository/",
		"https://update.electronjs.org./dankhole/quarterdeck/",
		"https://update.electronjs.org:443/dankhole/quarterdeck/",
		" https://updates.example/",
		"https://updates.example/\n",
		"file:///tmp/feed",
		"not a URL",
	])("rejects noncanonical or unsafe base %s", (value) => {
		expect(canonicalDesktopValidationFeedBase(value)).toBeNull();
	});
});
