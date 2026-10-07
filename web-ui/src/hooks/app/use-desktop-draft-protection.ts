import { useEffect, useRef } from "react";
import { registerDesktopDraftProtection } from "./desktop-draft-protection";

/** Registers an editor's own dirty check without duplicating its form state. */
export function useDesktopDraftProtection(label: string, dirty: boolean): void {
	const latest = useRef(dirty);
	latest.current = dirty;
	useEffect(() => registerDesktopDraftProtection(label, () => latest.current), [label]);
}
