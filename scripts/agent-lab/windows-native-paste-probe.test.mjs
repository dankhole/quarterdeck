import assert from "node:assert/strict";
import { test } from "node:test";
import { createPasteProbe } from "./windows-native-paste-probe.mjs";

const frame = Buffer.from("1b5b3230307e517561727465726465636b20636166c3a90de6bca2e5ad9720f09f9a800d6c6173742073796e746865746963206c696e651b5b3230317e", "hex");
const enter = Buffer.from([13]);

test("requires the exact UTF-8 frame across arbitrary chunk boundaries, then a separate Enter", () => {
	const probe = createPasteProbe();
	for (const [i, byte] of frame.entries()) assert.equal(probe.push(Buffer.from([byte])), i === frame.length - 1);
	assert.deepEqual(probe.checkpoint(), { pasteHex: frame.toString("hex"), submitsBeforeEnter: 0 });
	assert.throws(() => probe.finish(), /Missing exact separate Enter/);
	assert.equal(probe.push(enter), true);
	assert.deepEqual(probe.finish(), { inputHex: Buffer.concat([frame, enter]).toString("hex"), submits: 1 });
});

test("rejects early Enter, duplicate paste, unframed text, wrong Unicode and extra Enter", () => {
	for (const bytes of [Buffer.concat([frame, enter]), Buffer.concat([frame, frame]), frame.subarray(6), Buffer.from(frame.map((byte) => byte === 0xa9 ? 0xa8 : byte))]) {
		assert.throws(() => createPasteProbe().push(bytes), /Unexpected input/);
	}
	const probe = createPasteProbe();
	probe.push(frame);
	assert.throws(() => probe.push(enter), /paste phase/);
	probe.checkpoint();
	probe.push(enter);
	assert.throws(() => probe.push(enter), /enter phase/);
});
