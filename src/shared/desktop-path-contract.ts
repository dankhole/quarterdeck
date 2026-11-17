import { z } from "zod";

/** Wire paths may target either desktop host; filesystem canonicalization remains server-owned. */
export const desktopAbsolutePathSchema = z
	.string()
	.min(1)
	.max(4096)
	.refine((path) => {
		if (/[\p{Cc}]/u.test(path)) return false;
		if (/^[A-Za-z]:[\\/]/u.test(path)) return true;
		// Device namespaces are not project or installation paths.
		if (/^[\\/]{2}/u.test(path)) return /^[\\/]{2}[^\\/.?:]+[\\/][^\\/:]+(?:[\\/]|$)/u.test(path);
		return path.startsWith("/");
	}, "Expected an absolute desktop filesystem path.");
