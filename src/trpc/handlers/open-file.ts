import { TRPCError } from "@trpc/server";
import { openInBrowser } from "../../server/browser";

export async function handleOpenFile(input: { filePath: string }) {
	const filePath = input.filePath.trim();
	if (!filePath) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "File path cannot be empty.",
		});
	}
	openInBrowser(filePath);
	return { ok: true };
}
