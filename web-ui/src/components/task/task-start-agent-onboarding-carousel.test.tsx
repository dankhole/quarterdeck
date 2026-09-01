import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStartAgentOnboardingCarousel } from "@/components/task/task-start-agent-onboarding-carousel";
import { createTestAgentDef } from "@/test-utils/runtime-config-factory";

describe("TaskStartAgentOnboardingCarousel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("shows actionable provider setup without claiming credentials are verified", async () => {
		await act(async () => {
			root.render(
				<TaskStartAgentOnboardingCarousel
					selectedAgentId="claude"
					agents={[
						createTestAgentDef("claude"),
						createTestAgentDef("codex", { status: "missing", installed: false, configured: false }),
						createTestAgentDef("pi", {
							status: "upgrade_required",
							installed: false,
							configured: false,
							statusMessage: "Pi 0.84.4 is not supported; install exactly 0.84.3.",
						}),
					]}
					llmConfigured={false}
					runtimePlatform="mac"
					activeSlideIndex={0}
				/>,
			);
			await Promise.resolve();
		});

		expect(container.textContent).toContain("Set up a coding agent");
		expect(container.textContent).toContain("CLI ready");
		expect(container.textContent).toContain("claude auth status");
		expect(container.textContent).toContain("codex login status");
		expect(container.textContent).toContain("printenv OPENAI_API_KEY | codex login --with-api-key");
		expect(container.textContent).toContain("npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.3");
		expect(container.textContent).toContain("not provider credentials");
		expect(container.textContent).not.toContain("Add onboarding media");
	});

	it("explains the defaults that apply to the first task", async () => {
		await act(async () => {
			root.render(
				<TaskStartAgentOnboardingCarousel
					selectedAgentId="codex"
					agents={[createTestAgentDef("codex")]}
					llmConfigured={false}
					runtimePlatform="mac"
					activeSlideIndex={1}
				/>,
			);
			await Promise.resolve();
		});

		expect(container.textContent).toContain("Start with safe, local defaults");
		expect(container.textContent).toContain("Isolated worktrees");
		expect(container.textContent).toContain("Provider-native permissions");
		expect(container.textContent).toContain("No surprise model call");
	});

	it("offers LiteLLM as an optional existing or self-hosted helper", async () => {
		await act(async () => {
			root.render(
				<TaskStartAgentOnboardingCarousel
					selectedAgentId="codex"
					agents={[createTestAgentDef("codex")]}
					llmConfigured={false}
					runtimePlatform="mac"
					activeSlideIndex={2}
				/>,
			);
			await Promise.resolve();
		});

		expect(container.textContent).toContain("Optional: configure AI helpers");
		expect(container.textContent).toContain("Keep local defaults");
		expect(container.textContent).toContain("Use an existing or self-hosted gateway");
		expect(container.textContent).toContain("QUARTERDECK_LLM_BASE_URL");
		expect(container.textContent).toContain("QUARTERDECK_LLM_API_KEY");
		expect(container.textContent).toContain("QUARTERDECK_LLM_MODEL");
		expect(container.textContent).toContain("QUARTERDECK_TITLE_PROVIDER=llm");
	});

	it("shows Windows-native provider and helper setup commands", async () => {
		await act(async () => {
			root.render(
				<TaskStartAgentOnboardingCarousel
					selectedAgentId="codex"
					agents={[
						createTestAgentDef("claude", { status: "missing", installed: false, configured: false }),
						createTestAgentDef("codex", { status: "missing", installed: false, configured: false }),
					]}
					llmConfigured={false}
					runtimePlatform="windows"
					activeSlideIndex={0}
				/>,
			);
			await Promise.resolve();
		});

		expect(container.textContent).toContain("irm https://claude.ai/install.ps1 | iex");
		expect(container.textContent).toContain("https://chatgpt.com/codex/install.ps1");
		expect(container.textContent).toContain("$env:OPENAI_API_KEY | codex login --with-api-key");
		expect(container.textContent).toContain("claude auth status");
		expect(container.textContent).not.toContain("claude auth status --json");

		await act(async () => {
			root.render(
				<TaskStartAgentOnboardingCarousel
					selectedAgentId="codex"
					agents={[createTestAgentDef("codex")]}
					llmConfigured={false}
					runtimePlatform="windows"
					activeSlideIndex={2}
				/>,
			);
			await Promise.resolve();
		});

		expect(container.textContent).toContain('$env:QUARTERDECK_LLM_BASE_URL = "https://gateway.example.com"');
		expect(container.textContent).toContain('$env:QUARTERDECK_LLM_API_KEY = "your-gateway-key"');
		expect(container.textContent).toContain('$env:QUARTERDECK_LLM_MODEL = "your-model-alias"');
	});

	it("keeps a failed agent selection visible and blocks completion on later slides", async () => {
		let activeSlideIndex = 0;
		let doneAction: (() => Promise<{ ok: boolean; message?: string }>) | null = null;
		const render = () =>
			root.render(
				<TaskStartAgentOnboardingCarousel
					selectedAgentId="claude"
					agents={[createTestAgentDef("claude"), createTestAgentDef("codex")]}
					llmConfigured={false}
					runtimePlatform="mac"
					activeSlideIndex={activeSlideIndex}
					onSelectAgent={async () => ({ ok: false, message: "Could not save Codex selection." })}
					onDoneActionChange={(action) => {
						doneAction = action;
					}}
				/>,
			);

		await act(async () => {
			render();
			await Promise.resolve();
		});
		const codexButton = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("OpenAI Codex"),
		);
		expect(codexButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			codexButton?.click();
			await Promise.resolve();
			await Promise.resolve();
		});
		activeSlideIndex = 2;
		await act(async () => {
			render();
			await Promise.resolve();
		});

		expect(container.textContent).toContain("Could not save Codex selection.");
		expect(doneAction).not.toBeNull();
		let result: { ok: boolean; message?: string } | null | undefined = null;
		await act(async () => {
			result = await doneAction?.();
		});
		expect(result).toEqual({ ok: false, message: "Could not save Codex selection." });
	});
});
