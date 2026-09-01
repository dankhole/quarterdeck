import type { RuntimeAgentId } from "./api-contract";

export interface RuntimeAgentCatalogEntry {
	id: RuntimeAgentId;
	label: string;
	binary: string;
	baseArgs: string[];
	description: string;
	installCommand: string;
	windowsInstallCommand?: string;
	installUrl: string;
	signInCommand: string;
	signInDescription: string;
	apiKeySignInCommand?: string;
	windowsApiKeySignInCommand?: string;
	authStatusCommand?: string;
}

export const RUNTIME_AGENT_CATALOG: RuntimeAgentCatalogEntry[] = [
	{
		id: "claude",
		label: "Claude Code",
		binary: "claude",
		baseArgs: [],
		description: "Anthropic's coding agent CLI with access to Claude models.",
		installCommand: "curl -fsSL https://claude.ai/install.sh | bash",
		windowsInstallCommand: "irm https://claude.ai/install.ps1 | iex",
		installUrl: "https://code.claude.com/docs/en/getting-started",
		signInCommand: "claude",
		signInDescription: "Follow the browser prompt, or configure supported cloud-provider credentials.",
		authStatusCommand: "claude auth status",
	},
	{
		id: "codex",
		label: "OpenAI Codex",
		binary: "codex",
		baseArgs: [],
		description: "OpenAI's coding agent CLI with ChatGPT or API-key authentication.",
		installCommand: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
		windowsInstallCommand: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
		installUrl: "https://developers.openai.com/codex/cli",
		signInCommand: "codex login",
		signInDescription: "Use ChatGPT browser sign-in, or set OPENAI_API_KEY and run the API-key command.",
		apiKeySignInCommand: "printenv OPENAI_API_KEY | codex login --with-api-key",
		windowsApiKeySignInCommand: "$env:OPENAI_API_KEY | codex login --with-api-key",
		authStatusCommand: "codex login status",
	},
	{
		id: "pi",
		label: "Pi",
		binary: "pi",
		baseArgs: [],
		description: "Pi with launch-scoped project trust and configurable approval prompts.",
		installCommand: "npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.3",
		installUrl: "https://www.npmjs.com/package/@earendil-works/pi-coding-agent/v/0.84.3",
		signInCommand: "pi",
		signInDescription: "Start Pi, enter /login, and choose a provider.",
	},
];

export const RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS: readonly RuntimeAgentId[] = ["claude", "codex", "pi"];

const RUNTIME_LAUNCH_SUPPORTED_AGENT_ID_SET = new Set<RuntimeAgentId>(RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS);

export function isRuntimeAgentLaunchSupported(agentId: string): agentId is RuntimeAgentId {
	return RUNTIME_LAUNCH_SUPPORTED_AGENT_ID_SET.has(agentId as RuntimeAgentId);
}

export function getRuntimeLaunchSupportedAgentCatalog(): RuntimeAgentCatalogEntry[] {
	return RUNTIME_AGENT_CATALOG.filter((entry) => isRuntimeAgentLaunchSupported(entry.id));
}

export function getRuntimeAgentCatalogEntry(agentId: RuntimeAgentId): RuntimeAgentCatalogEntry | null {
	return RUNTIME_AGENT_CATALOG.find((entry) => entry.id === agentId) ?? null;
}
