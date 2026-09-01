import { getRuntimeAgentCatalogEntry } from "@runtime-agent-catalog";
import { Check, GitBranch, LockKeyhole, Sparkles } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import type { RuntimeAgentDefinition, RuntimeAgentId, RuntimeConfigResponse } from "@/runtime/types";
import { toErrorMessage } from "@/utils/to-error-message";

interface OnboardingSlide {
	kind: "agent-selection" | "safe-defaults" | "llm-helper";
	title: string;
	description: string;
}

interface AgentSelectionResult {
	ok: boolean;
	message?: string;
}

interface OnboardingDoneResult {
	ok: boolean;
	message?: string;
}

export const TASK_START_ONBOARDING_SLIDES: OnboardingSlide[] = [
	{
		kind: "agent-selection",
		title: "Set up a coding agent",
		description:
			"Quarterdeck uses an agent CLI already installed on your computer. Install and sign in to any one provider, then choose it here.",
	},
	{
		kind: "safe-defaults",
		title: "Start with safe, local defaults",
		description: "Quarterdeck is ready without another account, API key, or .env file.",
	},
	{
		kind: "llm-helper",
		title: "Optional: configure AI helpers",
		description:
			"Connect LiteLLM or another OpenAI-compatible gateway for generated branch names, commit messages, and summary polish.",
	},
];

const ONBOARDING_AGENT_IDS: readonly RuntimeAgentId[] = ["claude", "codex", "pi"];
const FALLBACK_ONBOARDING_SLIDE: OnboardingSlide = {
	kind: "agent-selection",
	title: "",
	description: "",
};

function AgentStatusBadge({ label, statusClassName }: { label: string; statusClassName: string }): ReactElement {
	return (
		<span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium", statusClassName)}>
			{label}
		</span>
	);
}

function AgentSetupCommand({ label, command }: { label: string; command: string }): ReactElement {
	return (
		<div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-2 text-[11px]">
			<span className="pt-1 font-medium text-text-tertiary">{label}</span>
			<code className="select-text overflow-x-auto rounded bg-surface-2 px-2 py-1 text-text-primary">{command}</code>
		</div>
	);
}

function formatEnvironmentCommand(
	name: "QUARTERDECK_LLM_BASE_URL" | "QUARTERDECK_LLM_API_KEY" | "QUARTERDECK_LLM_MODEL",
	value: string,
	runtimePlatform: RuntimeConfigResponse["runtimePlatform"],
): string {
	return runtimePlatform === "windows" ? `$env:${name} = "${value}"` : `export ${name}=${value}`;
}

function getAgentStatusBadge(agent: Pick<RuntimeAgentDefinition, "status" | "installed">): {
	label: string;
	statusClassName: string;
} {
	if (agent.status === "installed" && agent.installed) {
		return { label: "CLI ready", statusClassName: "bg-status-green/10 text-status-green" };
	}
	if (agent.status === "upgrade_required") {
		return { label: "Upgrade required", statusClassName: "bg-status-orange/10 text-status-orange" };
	}
	return { label: "Not installed", statusClassName: "bg-surface-3 text-text-secondary" };
}

const SAFE_DEFAULTS = [
	{
		icon: GitBranch,
		title: "Isolated worktrees",
		description:
			"New tasks use a separate git worktree by default, so parallel agents do not edit your main checkout.",
	},
	{
		icon: LockKeyhole,
		title: "Provider-native permissions",
		description:
			"Claude and Codex inherit their configured permission policy. Pi keeps tool approvals on because it has no Quarterdeck sandbox.",
	},
	{
		icon: Sparkles,
		title: "No surprise model call",
		description:
			"Task titles are generated locally unless you explicitly opt in to Codex or an OpenAI-compatible helper.",
	},
] as const;

function OptionalLlmHelperSetup({
	llmConfigured,
	runtimePlatform,
}: {
	llmConfigured: boolean;
	runtimePlatform: RuntimeConfigResponse["runtimePlatform"];
}): ReactElement {
	return (
		<div className="space-y-2">
			<div className="rounded-md border border-border bg-surface-1 p-3">
				<div className="flex items-center justify-between gap-3">
					<p className="m-0 text-[13px] font-medium text-text-primary">Keep local defaults</p>
					{!llmConfigured ? (
						<AgentStatusBadge label="Current" statusClassName="bg-status-green/10 text-status-green" />
					) : null}
				</div>
				<p className="mt-1 mb-0 text-[12px] text-text-secondary">
					No setup is required. Task titles stay local, summary polish stays off, and the optional branch-name and
					commit-message generators remain unavailable.
				</p>
			</div>

			<div className="rounded-md border border-border bg-surface-1 p-3">
				<div className="flex items-center justify-between gap-3">
					<p className="m-0 text-[13px] font-medium text-text-primary">Use an existing or self-hosted gateway</p>
					<AgentStatusBadge
						label={llmConfigured ? "Configured" : "Optional"}
						statusClassName={
							llmConfigured ? "bg-status-green/10 text-status-green" : "bg-surface-3 text-text-secondary"
						}
					/>
				</div>
				<p className="mt-1 mb-0 text-[12px] text-text-secondary">
					Quarterdeck does not install or manage the gateway. Point it at a team LiteLLM proxy, a local LiteLLM
					proxy, or another endpoint that supports OpenAI-style chat completions.
				</p>
				<div className="mt-2 space-y-1">
					<AgentSetupCommand
						label="Base URL"
						command={formatEnvironmentCommand(
							"QUARTERDECK_LLM_BASE_URL",
							"https://gateway.example.com",
							runtimePlatform,
						)}
					/>
					<AgentSetupCommand
						label="API key"
						command={formatEnvironmentCommand("QUARTERDECK_LLM_API_KEY", "your-gateway-key", runtimePlatform)}
					/>
					<AgentSetupCommand
						label="Model"
						command={formatEnvironmentCommand("QUARTERDECK_LLM_MODEL", "your-model-alias", runtimePlatform)}
					/>
				</div>
				<p className="mt-2 mb-0 text-[11px] text-text-tertiary">
					For LiteLLM, prefer a scoped virtual key and use a configured <code>model_name</code> alias. See the{" "}
					<a
						href="https://docs.litellm.ai/"
						target="_blank"
						rel="noreferrer"
						className="text-accent hover:underline"
					>
						LiteLLM proxy quick start
					</a>
					.
				</p>
			</div>

			<p className="m-0 rounded-md border border-border bg-surface-2 p-2 text-[11px] text-text-secondary">
				Keep gateway keys out of tracked files. Restart Quarterdeck after changing these variables. Task titles use
				the helper only when <code>QUARTERDECK_TITLE_PROVIDER=llm</code> is also set.
			</p>
		</div>
	);
}

export function TaskStartAgentOnboardingCarousel({
	selectedAgentId,
	agents,
	llmConfigured,
	runtimePlatform,
	activeSlideIndex,
	onSelectAgent,
	onDoneActionChange,
}: {
	selectedAgentId: RuntimeAgentId | null;
	agents: RuntimeAgentDefinition[];
	llmConfigured: boolean;
	runtimePlatform: RuntimeConfigResponse["runtimePlatform"];
	activeSlideIndex: number;
	onSelectAgent?: (agentId: RuntimeAgentId) => Promise<AgentSelectionResult>;
	onDoneActionChange?: (action: (() => Promise<OnboardingDoneResult>) | null) => void;
}): ReactElement {
	const [activeAgentId, setActiveAgentId] = useState<RuntimeAgentId | null>(selectedAgentId);
	const [selectionError, setSelectionError] = useState<string | null>(null);
	const selectionErrorRef = useRef<string | null>(null);
	const selectionSavePromiseRef = useRef<Promise<AgentSelectionResult> | null>(null);

	useEffect(() => {
		setActiveAgentId(selectedAgentId);
		selectionErrorRef.current = null;
		setSelectionError(null);
	}, [selectedAgentId]);

	const currentSlide =
		TASK_START_ONBOARDING_SLIDES[activeSlideIndex] ?? TASK_START_ONBOARDING_SLIDES[0] ?? FALLBACK_ONBOARDING_SLIDE;
	const onboardingAgents = useMemo(
		() =>
			ONBOARDING_AGENT_IDS.map((agentId) => {
				const configuredAgent = agents.find((agent) => agent.id === agentId) ?? null;
				const catalogEntry = getRuntimeAgentCatalogEntry(agentId);
				return {
					id: agentId,
					label: catalogEntry?.label ?? configuredAgent?.label ?? agentId,
					description: catalogEntry?.description ?? "Install from the provider's official documentation.",
					installCommand:
						runtimePlatform === "windows"
							? (catalogEntry?.windowsInstallCommand ?? catalogEntry?.installCommand ?? null)
							: (catalogEntry?.installCommand ?? null),
					installUrl: catalogEntry?.installUrl ?? null,
					signInCommand: catalogEntry?.signInCommand ?? null,
					signInDescription: catalogEntry?.signInDescription ?? null,
					apiKeySignInCommand:
						runtimePlatform === "windows"
							? (catalogEntry?.windowsApiKeySignInCommand ?? catalogEntry?.apiKeySignInCommand ?? null)
							: (catalogEntry?.apiKeySignInCommand ?? null),
					authStatusCommand: catalogEntry?.authStatusCommand ?? null,
					status: configuredAgent?.status ?? "missing",
					statusMessage: configuredAgent?.statusMessage ?? null,
					installed: configuredAgent?.installed ?? false,
				};
			}),
		[agents, runtimePlatform],
	);

	const handleAgentSelect = (agentId: RuntimeAgentId) => {
		const targetAgent = onboardingAgents.find((agent) => agent.id === agentId);
		if (targetAgent?.installed !== true || activeAgentId === agentId) {
			return;
		}
		setActiveAgentId(agentId);
		selectionErrorRef.current = null;
		setSelectionError(null);
		if (!onSelectAgent) {
			return;
		}
		const savePromise = onSelectAgent(agentId);
		selectionSavePromiseRef.current = savePromise;
		void savePromise
			.then((result) => {
				if (selectionSavePromiseRef.current !== savePromise) {
					return;
				}
				if (!result.ok) {
					const message = result.message ?? "Could not switch agents. Try again.";
					selectionErrorRef.current = message;
					setSelectionError(message);
					setActiveAgentId(selectedAgentId);
				}
			})
			.catch((error: unknown) => {
				if (selectionSavePromiseRef.current !== savePromise) {
					return;
				}
				const message = toErrorMessage(error);
				const selectionMessage = message || "Could not switch agents. Try again.";
				selectionErrorRef.current = selectionMessage;
				setSelectionError(selectionMessage);
				setActiveAgentId(selectedAgentId);
			})
			.finally(() => {
				if (selectionSavePromiseRef.current === savePromise) {
					selectionSavePromiseRef.current = null;
				}
			});
	};

	const handleDoneAction = useCallback(async (): Promise<OnboardingDoneResult> => {
		if (selectionSavePromiseRef.current) {
			const selectionResult = await selectionSavePromiseRef.current.catch((error: unknown) => ({
				ok: false,
				message: toErrorMessage(error),
			}));
			if (!selectionResult.ok) {
				const message = selectionResult.message ?? "Could not switch agents. Try again.";
				selectionErrorRef.current = message;
				setSelectionError(message);
				return { ok: false, message };
			}
		}
		if (selectionErrorRef.current) {
			return { ok: false, message: selectionErrorRef.current };
		}
		return { ok: true };
	}, []);

	useEffect(() => {
		onDoneActionChange?.(handleDoneAction);
		return () => {
			onDoneActionChange?.(null);
		};
	}, [handleDoneAction, onDoneActionChange]);

	return (
		<div className="space-y-3">
			<div>
				<h4 className="m-0 text-[15px] font-semibold text-text-primary">{currentSlide.title}</h4>
				<p className="mt-1 mb-0 text-[13px] text-text-secondary">{currentSlide.description}</p>
			</div>

			{currentSlide.kind === "agent-selection" ? (
				<div className="space-y-2">
					{onboardingAgents.map((agent) => (
						<div
							key={agent.id}
							className={cn(
								"rounded-md border bg-surface-1 p-3",
								activeAgentId === agent.id ? "border-accent" : "border-border",
							)}
						>
							<button
								type="button"
								disabled={!agent.installed}
								aria-pressed={activeAgentId === agent.id}
								onClick={() => handleAgentSelect(agent.id)}
								className="flex w-full items-center justify-between gap-3 text-left disabled:cursor-default"
							>
								<span className="flex items-center gap-2">
									<span
										aria-hidden="true"
										className={cn(
											"flex h-4 w-4 items-center justify-center rounded border border-border-bright bg-surface-2",
											activeAgentId === agent.id && "border-accent bg-accent",
											!agent.installed && "opacity-50",
										)}
									>
										{activeAgentId === agent.id ? <Check size={12} className="text-white" /> : null}
									</span>
									<span className="text-[13px] text-text-primary">{agent.label}</span>
								</span>
								<AgentStatusBadge {...getAgentStatusBadge(agent)} />
							</button>
							<p className="mt-2 mb-0 text-[12px] text-text-secondary">
								{agent.description}{" "}
								{agent.installUrl ? (
									<a
										href={agent.installUrl}
										target="_blank"
										rel="noreferrer"
										className="text-accent hover:underline"
									>
										Official setup
									</a>
								) : null}
							</p>
							<div className="mt-2 space-y-1">
								{agent.status !== "installed" && agent.installCommand ? (
									<AgentSetupCommand label="Install" command={agent.installCommand} />
								) : null}
								{agent.signInCommand ? (
									<AgentSetupCommand label="Sign in" command={agent.signInCommand} />
								) : null}
								{agent.apiKeySignInCommand ? (
									<AgentSetupCommand label="API key" command={agent.apiKeySignInCommand} />
								) : null}
								{agent.authStatusCommand ? (
									<AgentSetupCommand label="Verify" command={agent.authStatusCommand} />
								) : null}
							</div>
							{agent.signInDescription ? (
								<p className="mt-2 mb-0 text-[11px] text-text-tertiary">{agent.signInDescription}</p>
							) : null}
							{agent.statusMessage ? (
								<p className="mt-2 mb-0 text-[12px] text-status-orange">{agent.statusMessage}</p>
							) : null}
						</div>
					))}
					<p className="m-0 rounded-md border border-border bg-surface-2 p-2 text-[11px] text-text-secondary">
						“CLI ready” verifies the executable and supported version, not provider credentials. Finish sign-in
						before starting a task. Restart Quarterdeck after installing a CLI so it inherits your updated PATH.
					</p>
				</div>
			) : currentSlide.kind === "safe-defaults" ? (
				<div className="space-y-2">
					{SAFE_DEFAULTS.map(({ icon: Icon, title, description }) => (
						<div key={title} className="flex gap-3 rounded-md border border-border bg-surface-1 p-3">
							<Icon size={17} className="mt-0.5 shrink-0 text-accent" />
							<div>
								<p className="m-0 text-[13px] font-medium text-text-primary">{title}</p>
								<p className="mt-1 mb-0 text-[12px] text-text-secondary">{description}</p>
							</div>
						</div>
					))}
					<p className="m-0 text-[12px] text-text-secondary">
						Press <kbd className="rounded bg-surface-3 px-1.5 py-0.5 text-text-primary">C</kbd> to create your
						first task. Worktrees and confirmations can be changed later in Settings.
					</p>
				</div>
			) : (
				<OptionalLlmHelperSetup llmConfigured={llmConfigured} runtimePlatform={runtimePlatform} />
			)}
			{selectionError ? (
				<div className="rounded-md border border-status-red/30 bg-status-red/5 p-2 text-[12px] text-text-primary">
					{selectionError}
				</div>
			) : null}
		</div>
	);
}
