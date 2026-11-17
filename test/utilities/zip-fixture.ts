import { crc32 } from "node:zlib";

/** Minimal independent ZIP writer for valid and deliberately hostile stored entries. */
export function zipFixture(
	entries: Array<{ name: string; data?: Buffer; attributes?: number; declaredSize?: number }>,
): Buffer {
	const local: Buffer[] = [],
		central: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name),
			data = entry.data ?? Buffer.alloc(0),
			size = entry.declaredSize ?? data.length;
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(0x800, 6);
		header.writeUInt32LE(crc32(data), 14);
		header.writeUInt32LE(data.length, 18);
		header.writeUInt32LE(size, 22);
		header.writeUInt16LE(name.length, 26);
		local.push(header, name, data);
		const record = Buffer.alloc(46);
		record.writeUInt32LE(0x02014b50);
		record.writeUInt16LE(0x314, 4);
		record.writeUInt16LE(20, 6);
		record.writeUInt16LE(0x800, 8);
		record.writeUInt32LE(crc32(data), 16);
		record.writeUInt32LE(data.length, 20);
		record.writeUInt32LE(size, 24);
		record.writeUInt16LE(name.length, 28);
		record.writeUInt32LE(entry.attributes ?? (0o100600 << 16) >>> 0, 38);
		record.writeUInt32LE(offset, 42);
		central.push(record, name);
		offset += header.length + name.length + data.length;
	}
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(
		central.reduce((size, chunk) => size + chunk.length, 0),
		12,
	);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, ...central, end]);
}
