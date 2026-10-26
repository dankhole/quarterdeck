import type { LanguageDescription, LanguageSupport } from "@codemirror/language";
import { useEffect, useState } from "react";
import { resolveSourceLanguage } from "@/components/editor/source-language-registry";

export function useSourceLanguage(language: string, path: string): LanguageSupport | null {
	const description = resolveSourceLanguage(language, path);
	const available = description?.support ?? null;
	const [loaded, setLoaded] = useState<{ description: LanguageDescription; support: LanguageSupport } | null>(null);

	useEffect(() => {
		// Use the render snapshot: a different consumer may warm the mutable SDK
		// cache during commit, but this render still needs its own state update.
		if (!description || available) return;
		let current = true;
		try {
			void description.load().then(
				(support) => {
					if (current) setLoaded({ description, support });
				},
				() => {
					// Leave plain text on failure. Retry only after changing language or
					// remounting, never as a render-driven retry loop.
				},
			);
		} catch {
			// SDK loaders may also throw before returning a promise. Keep the
			// same plain-text/no-automatic-retry behavior for that failure.
		}
		return () => {
			current = false;
		};
	}, [description, available]);

	return available ?? (loaded?.description === description ? loaded.support : null);
}
