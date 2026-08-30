const WINDOWS_RESERVED_NAME_PATTERN =
	/^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com(?:[1-9¹²³])|lpt(?:[1-9¹²³]))(?:\..*)?$/iu;
const WINDOWS_INVALID_PATH_CHARACTERS = '<>:"|?*';
const WINDOWS_MAX_PATH_COMPONENT_CODE_UNITS = 255;

function hasWindowsInvalidPathCharacter(component: string): boolean {
	for (const character of component) {
		const codePoint = character.codePointAt(0);
		if ((codePoint !== undefined && codePoint <= 0x1f) || WINDOWS_INVALID_PATH_CHARACTERS.includes(character)) {
			return true;
		}
	}
	return false;
}

/** Whether one filename component can be represented by Win32 filesystems. */
export function isWindowsSafePathComponent(component: string): boolean {
	return (
		component.length > 0 &&
		component.length <= WINDOWS_MAX_PATH_COMPONENT_CODE_UNITS &&
		!hasWindowsInvalidPathCharacter(component) &&
		!/[. ]$/u.test(component) &&
		!WINDOWS_RESERVED_NAME_PATTERN.test(component)
	);
}
