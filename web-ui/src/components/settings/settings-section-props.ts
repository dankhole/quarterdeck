// Shared props interface for all settings dialog sections.
import type { SettingsFormValues } from "@/hooks/use-settings-form";

export interface SettingsSectionProps {
	fields: SettingsFormValues;
	setField: <K extends keyof SettingsFormValues>(key: K, value: SettingsFormValues[K]) => void;
	disabled: boolean;
}
