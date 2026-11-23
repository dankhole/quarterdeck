import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const clipboardText = "Quarterdeck caf\u00e9\r\n\u6f22\u5b57 \u{1f680}\r\nlast synthetic line";
// xterm maps CRLF/LF to CR before framing; the last CR below is a separate key.
const frame = Buffer.from(`\x1b[200~${clipboardText.replaceAll("\r\n", "\r")}\x1b[201~`);
const submitted = Buffer.concat([frame, Buffer.from("\r")]);
export const quietMs = 1500;

export function createPasteProbe() {
	let bytes = Buffer.alloc(0);
	let phase = "paste";
	return {
		push(chunk) {
			const expected = phase === "paste" ? frame : submitted;
			const length = bytes.length + chunk.length;
			if (length > expected.length || !chunk.equals(expected.subarray(bytes.length, length))) {
				throw new Error(`Unexpected input in ${phase} phase at chunk offset ${bytes.length}; received ${length} bytes total.`);
			}
			bytes = Buffer.concat([bytes, chunk]);
			return bytes.length === expected.length;
		},
		checkpoint() {
			if (phase !== "paste" || !bytes.equals(frame)) throw new Error("Missing exact paste checkpoint.");
			phase = "enter";
			return { pasteHex: bytes.toString("hex"), submitsBeforeEnter: 0 };
		},
		finish() {
			if (phase !== "enter" || !bytes.equals(submitted)) throw new Error("Missing exact separate Enter.");
			return { inputHex: bytes.toString("hex"), submits: 1 };
		},
	};
}

function run() {
	const input = process.stdin;
	const output = process.stdout;
	if (process.platform !== "win32" || !input.isTTY || !output.isTTY || process.env.CI)
		throw new Error("Use the isolated interactive Windows Agent Lab protocol.");
	const probe = createPasteProbe();
	let checkpoint;
	let timer;
	let done = false;
	const deadline = setTimeout(() => stop(new Error("Timed out waiting for physical paste or separate Enter.")), 120_000);
	function stop(error, result) {
		if (done) return;
		done = true;
		clearTimeout(deadline);
		clearTimeout(timer);
		input.setRawMode(false);
		input.pause();
		output.write(`\x1b[?2004l\r\n${error ? `FAIL: ${error.message}` : "PASS: exact frame then one Enter"}\r\n`);
		writeFileSync("native-paste-receipt.json", `${JSON.stringify({
			pid: process.pid, quietMs, checkpoint, ...result, failure: error?.message ?? null,
		})}\n`, { flag: "wx" });
		process.exitCode = error ? 1 : 0;
	}
	input.setRawMode(true);
	input.on("data", (chunk) => {
		try {
			if (probe.push(chunk)) {
				clearTimeout(timer);
				timer = setTimeout(() => {
					if (checkpoint) stop(null, probe.finish());
					else {
						checkpoint = probe.checkpoint();
						output.write("\r\nPASTE ONLY: exact frame, zero submits. Press Enter once now.\r\n");
					}
				}, quietMs);
			}
		} catch (error) {
			stop(error);
		}
	});
	output.write("\x1b[?2004h\r\nREADY: physically press Ctrl+V once, then wait.\r\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
