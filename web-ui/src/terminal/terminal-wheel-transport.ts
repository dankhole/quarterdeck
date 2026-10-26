interface WheelReports {
	data: string;
	binary: boolean | null;
}

/** Coalesce only complete xterm wheel reports during one synchronous DOM wheel dispatch. */
export class TerminalWheelTransport {
	private reports: WheelReports | null = null;
	private disposed = false;

	constructor(private readonly send: (data: string | Uint8Array) => void) {}

	batchWheelReports(dispatch: () => void): void {
		if (this.disposed) return;
		const parent = this.reports;
		// Reentrant physical wheel events keep their own transport boundary.
		this.flush(parent);
		if (this.disposed) return;
		const reports: WheelReports = { data: "", binary: null };
		this.reports = reports;
		try {
			dispatch();
		} finally {
			this.reports = this.disposed ? null : parent;
			// Already encoded reports remain deliverable even if dispatch throws.
			this.flush(reports);
		}
	}

	forward(data: string, binary = false): void {
		if (this.disposed) return;
		const reports = this.reports;
		// xterm 6 emits SGR/SGR-pixel via onData and legacy mouse via onBinary.
		// Recognize complete unmodified wheel reports, never encode or rewrite them.
		// Regex '$' permits a final newline; exclude it so submit bytes stay separate.
		const wheelReport =
			reports &&
			data.startsWith("\x1b[") &&
			(binary ? /^M[\x60\x61][\x21-\xff]{2}$/.test(data.slice(2)) : /^<6[45];\d+;\d+M$/.test(data.slice(2))) &&
			!data.endsWith("\n");
		if (reports && wheelReport) {
			if (reports.binary !== null && reports.binary !== binary) this.flush(reports);
			if (this.disposed) return;
			reports.binary = binary;
			reports.data += data;
			return;
		}
		// A reentrant key, paste, click or protocol reply must retain its exact boundary/order.
		this.flush(reports);
		if (!this.disposed) this.sendData(data, binary);
	}

	private flush(reports: WheelReports | null): void {
		if (!reports?.data) return;
		const { data, binary } = reports;
		reports.data = "";
		reports.binary = null;
		if (!this.disposed) this.sendData(data, binary === true);
	}

	private sendData(data: string, binary: boolean): void {
		if (!binary) {
			this.send(data);
			return;
		}
		const bytes = new Uint8Array(data.length);
		for (let index = 0; index < data.length; index += 1) bytes[index] = data.charCodeAt(index) & 0xff;
		this.send(bytes);
	}

	dispose(): void {
		this.disposed = true;
		this.reports = null;
	}
}
