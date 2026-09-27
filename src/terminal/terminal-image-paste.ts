import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeTaskImage } from "../core";

const EXTENSIONS: Readonly<Record<string, string>> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
};

/** Keep successful attachments in OS temp storage, like initial task images.
 * The provider can read them after submission; failed deliveries are removed. */
export async function prepareTerminalImagePaste(images: RuntimeTaskImage[]): Promise<{
	data: Buffer;
	discard: () => Promise<void>;
}> {
	const directory = await mkdtemp(join(tmpdir(), "quarterdeck-pasted-images-"));
	const discard = () => rm(directory, { recursive: true, force: true });
	try {
		const paths: string[] = [];
		for (const [index, image] of images.entries()) {
			const extension = EXTENSIONS[image.mimeType];
			if (!extension) throw new Error("Unsupported image type.");
			const path = join(directory, `${index + 1}${extension}`);
			await writeFile(path, Buffer.from(image.data, "base64"), { mode: 0o600 });
			paths.push(path);
		}
		// One bracketed paste per image lets the TUI recognize each attachment.
		// Never include submit/newline bytes, and never paste into a shell.
		return {
			data: Buffer.from(paths.map((path) => `\u001b[200~${path}\u001b[201~`).join("")),
			discard,
		};
	} catch (error) {
		await discard();
		throw error;
	}
}
