import { open } from "node:fs/promises";

/** Read only DOS/PE headers; candidate binaries are never executed for architecture inspection. */
export async function windowsPeArchitecture(path) {
	const file = await open(path, "r");
	try {
		const header = Buffer.alloc(64);
		if ((await file.read(header, 0, 64, 0)).bytesRead !== 64 || header.readUInt16LE(0) !== 0x5a4d)
			throw new Error("Invalid Windows executable header.");
		const offset = header.readUInt32LE(60);
		if (offset < 64 || offset > 1024 * 1024) throw new Error("Invalid Windows PE offset.");
		const pe = Buffer.alloc(6);
		if ((await file.read(pe, 0, 6, offset)).bytesRead !== 6 || pe.readUInt32LE(0) !== 0x4550)
			throw new Error("Invalid Windows PE signature.");
		const machine = pe.readUInt16LE(4);
		if (machine === 0x8664) return "x64";
		if (machine === 0xaa64) return "arm64";
		throw new Error("Unsupported Windows executable architecture.");
	} finally {
		await file.close();
	}
}
