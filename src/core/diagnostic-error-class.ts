// Canonical, zod-free leaf for diagnostic error-class normalization. `./api/diagnostics.ts`
// (which also defines the full diagnostics zod schema surface, ~10KB) re-exports
// `normalizeDiagnosticErrorClass` from here rather than keeping its own copy, so there is
// exactly one definition. The lightweight hook entry (`dist/hooks.js`) imports only this
// leaf module, never `./api/diagnostics.ts`, keeping that hot CLI path narrow.
const DIAGNOSTIC_ERROR_CLASS_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u;

export function normalizeDiagnosticErrorClass(value: string): string {
	const normalized = value.trim();
	return DIAGNOSTIC_ERROR_CLASS_PATTERN.test(normalized) ? normalized : "UnknownError";
}

/** Normalizes an unknown caught value's error class in one step. */
export function diagnosticErrorClassOf(error: unknown): string {
	return normalizeDiagnosticErrorClass(error instanceof Error ? error.name : "UnknownError");
}
