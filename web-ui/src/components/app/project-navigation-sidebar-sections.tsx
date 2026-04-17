import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronDown, ChevronUp, ExternalLink, Lightbulb, X } from "lucide-react";
import { useState } from "react";
import { Kbd } from "@/components/ui/kbd";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { isMacPlatform, modifierKeyLabel } from "@/utils/platform";
import { useBooleanLocalStorageValue } from "@/utils/react-use";

const ONBOARDING_TIPS = [
	{ label: "Create tasks", hint: "Add prompts to the backlog, then start them to spawn isolated agents" },
	{ label: "Run in parallel", hint: "Each task gets its own git worktree — agents work simultaneously" },
	{ label: "Review changes", hint: "When an agent finishes, review its diff and commit or iterate" },
] as const;

const MOD = isMacPlatform ? "⌘" : modifierKeyLabel;
const ALT = isMacPlatform ? "⌥" : "Alt";

const ESSENTIAL_SHORTCUTS = [
	{ keys: ["C"], label: "New task" },
	{ keys: [MOD, "B"], label: "Start backlog tasks" },
	{ keys: [MOD, "Shift", "S"], label: "Settings" },
	{ keys: ["Click", MOD], label: "Hold to link tasks" },
	{ keys: [MOD, "G"], label: "Toggle git view" },
	{ keys: [MOD, "J"], label: "Toggle terminal" },
];

const MORE_SHORTCUTS = [
	{ keys: [MOD, "P"], label: "Find file" },
	{ keys: [MOD, "Shift", "F"], label: "Search in files" },
	{ keys: [MOD, "Shift", "A"], label: "Toggle plan / act" },
	{ keys: [ALT, "Shift", "Enter"], label: "Start and open task" },
	{ keys: [MOD, "M"], label: "Expand terminal" },
	{ keys: ["Esc"], label: "Close / back" },
];

const GITHUB_ISSUES_URL = "https://github.com/dankhole/quarterdeck/issues";

function ShortcutHint({ keys, label }: { keys: string[]; label: string }): React.ReactElement {
	return (
		<div className="flex justify-between items-center py-px">
			<span className="text-text-tertiary text-xs">{label}</span>
			<span className="inline-flex items-center gap-0.5">
				{keys.map((key, index) => (
					<Kbd key={`${key}-${index}`}>{key}</Kbd>
				))}
			</span>
		</div>
	);
}

function OnboardingTips(): React.ReactElement | null {
	const [isDismissed, setIsDismissed] = useBooleanLocalStorageValue(LocalStorageKey.OnboardingTipsDismissed, false);

	if (isDismissed) {
		return (
			<div style={{ padding: "0 20px 4px" }}>
				<button
					type="button"
					onClick={() => setIsDismissed(false)}
					className="flex cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-[11px] text-text-tertiary hover:text-text-secondary"
				>
					<Lightbulb size={11} />
					Show tips
				</button>
			</div>
		);
	}

	return (
		<div style={{ padding: "4px 12px" }}>
			<div className="rounded-md border border-border-bright/50 bg-surface-0/60 px-3 py-2">
				<div className="flex items-center justify-between mb-1.5">
					<span className="text-[11px] font-medium text-text-secondary flex items-center gap-1">
						<Lightbulb size={11} className="text-status-gold" />
						Getting started
					</span>
					<button
						type="button"
						onClick={() => setIsDismissed(true)}
						className="cursor-pointer border-none bg-transparent p-0 text-text-tertiary hover:text-text-secondary"
						aria-label="Dismiss tips"
					>
						<X size={12} />
					</button>
				</div>
				<ul className="m-0 p-0 list-none space-y-1">
					{ONBOARDING_TIPS.map((tip) => (
						<li key={tip.label} className="text-[11px] text-text-tertiary">
							<span className="text-text-primary font-medium">{tip.label}</span> — {tip.hint}
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}

function ShortcutsCard(): React.ReactElement {
	const [expanded, setExpanded] = useState(false);

	return (
		<div style={{ padding: "8px 12px" }}>
			<div style={{ padding: "0 8px" }}>
				<div className="flex flex-col gap-0.5">
					{ESSENTIAL_SHORTCUTS.map((shortcut) => (
						<ShortcutHint key={shortcut.label} keys={shortcut.keys} label={shortcut.label} />
					))}
				</div>
				<Collapsible.Root open={expanded} onOpenChange={setExpanded}>
					<Collapsible.Content>
						<div className="flex flex-col gap-0.5">
							{MORE_SHORTCUTS.map((shortcut) => (
								<ShortcutHint key={shortcut.label} keys={shortcut.keys} label={shortcut.label} />
							))}
						</div>
					</Collapsible.Content>
					<Collapsible.Trigger asChild>
						<button
							type="button"
							className="flex items-center gap-1 mt-1.5 text-xs text-text-tertiary hover:text-text-secondary cursor-pointer bg-transparent border-none p-0"
						>
							{expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
							{expanded ? "Less" : "All shortcuts"}
						</button>
					</Collapsible.Trigger>
				</Collapsible.Root>
			</div>
		</div>
	);
}

function BetaNotice(): React.ReactElement {
	return (
		<div style={{ padding: "4px 12px 12px" }}>
			<div className="flex items-start gap-2 rounded-md border border-status-orange/25 bg-status-orange/5 px-3 py-2.5">
				<div className="flex flex-col gap-1.5">
					<p className="m-0 text-xs text-status-orange/80">
						Quarterdeck is in beta. Help me improve by sharing your experience.
					</p>
					<a
						href={GITHUB_ISSUES_URL}
						target="_blank"
						rel="noopener noreferrer"
						className="flex items-center gap-1 self-start text-xs font-semibold text-status-orange hover:text-status-orange/80 active:text-status-orange/60 no-underline"
					>
						Report issue <ExternalLink size={11} />
					</a>
				</div>
			</div>
		</div>
	);
}

export function ProjectNavigationSidebarSections(): React.ReactElement {
	return (
		<>
			<OnboardingTips />
			<ShortcutsCard />
			<BetaNotice />
		</>
	);
}
