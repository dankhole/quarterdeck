/**
 * Find the next available shortcut label that doesn't collide with
 * existing labels. Appends a numeric suffix if needed.
 */
export function getNextShortcutLabel(baseLabel: string, existingLabels: string[]): string {
	const normalizedTaken = new Set(
		existingLabels.map((label) => label.trim().toLowerCase()).filter((label) => label.length > 0),
	);
	const normalizedBase = baseLabel.trim().toLowerCase();
	if (!normalizedTaken.has(normalizedBase)) {
		return baseLabel;
	}
	let suffix = 2;
	while (normalizedTaken.has(`${normalizedBase} ${suffix}`)) {
		suffix += 1;
	}
	return `${baseLabel} ${suffix}`;
}

/**
 * Validate and normalize a shortcut for creation.
 * Returns the validated shortcut or an error message.
 */
export function validateNewShortcut(
	command: string,
	label: string,
	existingLabels: string[],
): { ok: true; label: string; command: string } | { ok: false; message: string } {
	const normalizedCommand = command.trim();
	if (normalizedCommand.length === 0) {
		return { ok: false, message: "Command is required." };
	}
	const baseLabel = label.trim().length > 0 ? label.trim() : "Run";
	const nextLabel = getNextShortcutLabel(baseLabel, existingLabels);
	return { ok: true, label: nextLabel, command: normalizedCommand };
}
