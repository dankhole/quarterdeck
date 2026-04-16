import { afterEach, describe, expect, it, vi } from "vitest";
import {
	extractAvailableTags,
	filterLogEntries,
	LEVEL_ORDER,
	loadDisabledTags,
	mergeLogEntries,
	persistDisabledTags,
} from "@/hooks/debug/debug-logging";
import type { RuntimeDebugLogEntry } from "@/runtime/types";

const mockStore = new Map<string, string>();

vi.mock("@/storage/local-storage-store", () => ({
	LocalStorageKey: { DebugLogDisabledTags: "quarterdeck.debug-log-disabled-tags" },
	readLocalStorageItem: (key: string) => mockStore.get(key) ?? null,
	writeLocalStorageItem: (key: string, value: string) => {
		mockStore.set(key, value);
	},
}));

function entry(overrides: Partial<RuntimeDebugLogEntry> & { id: string }): RuntimeDebugLogEntry {
	return {
		timestamp: 1000,
		level: "info",
		tag: "test",
		message: "hello",
		source: "server",
		...overrides,
	};
}

afterEach(() => {
	mockStore.clear();
});

describe("LEVEL_ORDER", () => {
	it("orders debug < info < warn < error", () => {
		expect(LEVEL_ORDER.debug).toBeLessThan(LEVEL_ORDER.info!);
		expect(LEVEL_ORDER.info).toBeLessThan(LEVEL_ORDER.warn!);
		expect(LEVEL_ORDER.warn).toBeLessThan(LEVEL_ORDER.error!);
	});
});

describe("loadDisabledTags / persistDisabledTags", () => {
	it("returns empty set when nothing stored", () => {
		expect(loadDisabledTags()).toEqual(new Set());
	});

	it("round-trips a set of tags", () => {
		const tags = new Set(["alpha", "beta"]);
		persistDisabledTags(tags);
		expect(loadDisabledTags()).toEqual(tags);
	});

	it("ignores malformed JSON", () => {
		mockStore.set("quarterdeck.debug-log-disabled-tags", "not json");
		expect(loadDisabledTags()).toEqual(new Set());
	});

	it("ignores non-array JSON", () => {
		mockStore.set("quarterdeck.debug-log-disabled-tags", '{"a":1}');
		expect(loadDisabledTags()).toEqual(new Set());
	});

	it("filters out non-string array elements", () => {
		mockStore.set("quarterdeck.debug-log-disabled-tags", '["ok", 42, null, "also-ok"]');
		expect(loadDisabledTags()).toEqual(new Set(["ok", "also-ok"]));
	});
});

describe("mergeLogEntries", () => {
	it("returns server entries when no client entries", () => {
		const server = [entry({ id: "s1", timestamp: 100 })];
		expect(mergeLogEntries(server, [], 0)).toBe(server);
	});

	it("merges and sorts by timestamp", () => {
		const server = [entry({ id: "s1", timestamp: 100 }), entry({ id: "s2", timestamp: 300 })];
		const client = [entry({ id: "c1", timestamp: 200, source: "client" })];
		const merged = mergeLogEntries(server, client, 0);
		expect(merged.map((e) => e.id)).toEqual(["s1", "c1", "s2"]);
	});

	it("filters entries before clearedAt", () => {
		const server = [entry({ id: "s1", timestamp: 100 }), entry({ id: "s2", timestamp: 300 })];
		const client = [entry({ id: "c1", timestamp: 200, source: "client" })];
		const merged = mergeLogEntries(server, client, 250);
		expect(merged.map((e) => e.id)).toEqual(["s2"]);
	});

	it("returns server-only when client entries are all cleared", () => {
		const server = [entry({ id: "s1", timestamp: 500 })];
		const client = [entry({ id: "c1", timestamp: 100, source: "client" })];
		const merged = mergeLogEntries(server, client, 200);
		expect(merged).toEqual([server[0]]);
	});
});

describe("extractAvailableTags", () => {
	it("returns sorted unique tags", () => {
		const entries = [
			entry({ id: "1", tag: "beta" }),
			entry({ id: "2", tag: "alpha" }),
			entry({ id: "3", tag: "beta" }),
			entry({ id: "4", tag: "gamma" }),
		];
		expect(extractAvailableTags(entries)).toEqual(["alpha", "beta", "gamma"]);
	});

	it("returns empty array for no entries", () => {
		expect(extractAvailableTags([])).toEqual([]);
	});
});

describe("filterLogEntries", () => {
	const defaults = {
		showConsoleCapture: true,
		disabledTags: new Set<string>(),
		levelFilter: "all" as const,
		sourceFilter: "all" as const,
		searchText: "",
	};

	it("returns all entries with default filters", () => {
		const entries = [entry({ id: "1" }), entry({ id: "2" })];
		expect(filterLogEntries(entries, defaults)).toEqual(entries);
	});

	it("filters out console entries when showConsoleCapture is false", () => {
		const entries = [entry({ id: "1", tag: "console" }), entry({ id: "2", tag: "other" })];
		expect(filterLogEntries(entries, { ...defaults, showConsoleCapture: false }).map((e) => e.id)).toEqual(["2"]);
	});

	it("filters out disabled tags", () => {
		const entries = [entry({ id: "1", tag: "debug" }), entry({ id: "2", tag: "api" })];
		const result = filterLogEntries(entries, { ...defaults, disabledTags: new Set(["debug"]) });
		expect(result.map((e) => e.id)).toEqual(["2"]);
	});

	it("filters by level (warn shows warn and error)", () => {
		const entries = [
			entry({ id: "1", level: "debug" }),
			entry({ id: "2", level: "info" }),
			entry({ id: "3", level: "warn" }),
			entry({ id: "4", level: "error" }),
		];
		const result = filterLogEntries(entries, { ...defaults, levelFilter: "warn" });
		expect(result.map((e) => e.id)).toEqual(["3", "4"]);
	});

	it("filters by source", () => {
		const entries = [entry({ id: "1", source: "server" }), entry({ id: "2", source: "client" })];
		const result = filterLogEntries(entries, { ...defaults, sourceFilter: "client" });
		expect(result.map((e) => e.id)).toEqual(["2"]);
	});

	it("filters by search text in message", () => {
		const entries = [entry({ id: "1", message: "Connection failed" }), entry({ id: "2", message: "Task started" })];
		const result = filterLogEntries(entries, { ...defaults, searchText: "failed" });
		expect(result.map((e) => e.id)).toEqual(["1"]);
	});

	it("filters by search text in tag", () => {
		const entries = [entry({ id: "1", tag: "websocket" }), entry({ id: "2", tag: "trpc" })];
		const result = filterLogEntries(entries, { ...defaults, searchText: "socket" });
		expect(result.map((e) => e.id)).toEqual(["1"]);
	});

	it("filters by search text in string data", () => {
		const entries = [entry({ id: "1", data: "extra context here" }), entry({ id: "2", data: { nested: true } })];
		const result = filterLogEntries(entries, { ...defaults, searchText: "context" });
		expect(result.map((e) => e.id)).toEqual(["1"]);
	});

	it("search is case-insensitive", () => {
		const entries = [entry({ id: "1", message: "Error Occurred" })];
		const result = filterLogEntries(entries, { ...defaults, searchText: "error occurred" });
		expect(result.map((e) => e.id)).toEqual(["1"]);
	});

	it("combines multiple filters", () => {
		const entries = [
			entry({ id: "1", level: "debug", tag: "api", source: "server", message: "ping" }),
			entry({ id: "2", level: "error", tag: "api", source: "server", message: "ping failed" }),
			entry({ id: "3", level: "error", tag: "api", source: "client", message: "ping failed" }),
			entry({ id: "4", level: "error", tag: "ws", source: "server", message: "ping failed" }),
		];
		const result = filterLogEntries(entries, {
			...defaults,
			levelFilter: "error",
			sourceFilter: "server",
			searchText: "failed",
			disabledTags: new Set(["ws"]),
		});
		expect(result.map((e) => e.id)).toEqual(["2"]);
	});
});
