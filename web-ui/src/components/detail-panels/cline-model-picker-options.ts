import type { SearchSelectOption } from "@/components/search-select-dropdown";
import type { RuntimeClineProviderModel } from "@/runtime/types";

const CLINE_PROVIDER_ID = "cline";

export const CLINE_RECOMMENDED_MODEL_IDS = [
	"anthropic/claude-opus-4.6",
	"anthropic/claude-sonnet-4.6",
	"openai/gpt-5.3-codex",
	"openai/gpt-5.4",
	"google/gemini-3.1-pro-preview",
	"google/gemini-3.1-flash-lite-preview",
	"xiaomi/mimo-v2-pro",
] as const;

export interface BuildClineAgentModelPickerOptionsResult {
	options: SearchSelectOption[];
	recommendedModelIds: string[];
	shouldPinSelectedModelToTop: boolean;
}

export function buildClineAgentModelPickerOptions(
	providerId: string,
	providerModels: readonly RuntimeClineProviderModel[],
): BuildClineAgentModelPickerOptionsResult {
	const defaultOptions = providerModels.map((model) => ({
		value: model.id,
		label: model.name,
	}));
	if (providerId.trim().toLowerCase() !== CLINE_PROVIDER_ID) {
		return {
			options: defaultOptions,
			recommendedModelIds: [],
			shouldPinSelectedModelToTop: true,
		};
	}

	const optionsById = new Map(defaultOptions.map((option) => [option.value, option] as const));
	const recommendedOptions = CLINE_RECOMMENDED_MODEL_IDS.map((modelId) => optionsById.get(modelId)).filter(
		(option): option is SearchSelectOption => option !== undefined,
	);
	const recommendedModelIds = recommendedOptions.map((option) => option.value);
	const recommendedModelIdSet = new Set(recommendedModelIds);
	const nonRecommendedOptions = defaultOptions.filter((option) => !recommendedModelIdSet.has(option.value));

	return {
		options: [...recommendedOptions, ...nonRecommendedOptions],
		recommendedModelIds,
		shouldPinSelectedModelToTop: false,
	};
}
