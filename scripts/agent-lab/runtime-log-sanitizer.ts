import { Transform } from "node:stream";

export function sanitizeRuntimeLogOutput(text: string): string {
	return text
		.replace(/Browser URL: \S+/g, "Browser URL: [private browser bootstrap]")
		.replace(
			/(?:https?:\/\/[^\s"'<>]*)?\/api\/runtime\/client-bootstrap\?[^\s"'<>]*/g,
			"[private browser bootstrap]",
		);
}

/** Production CLI prints a one-use browser capability; lab evidence must retain only stable URLs. */
export function createRuntimeLogSanitizer(): Transform {
	let pending = "";
	return new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			pending += chunk.toString("utf8");
			const boundary = pending.lastIndexOf("\n");
			if (boundary >= 0) {
				this.push(sanitizeRuntimeLogOutput(pending.slice(0, boundary + 1)));
				pending = pending.slice(boundary + 1);
			}
			callback();
		},
		flush(callback) {
			if (pending) this.push(sanitizeRuntimeLogOutput(pending));
			callback();
		},
	});
}
