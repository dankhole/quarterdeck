import { Button } from "@/components/ui/button";
import type { FeaturebaseFeedbackState } from "@/hooks/use-featurebase-feedback-widget";
import type { RuntimeAgentId } from "@/runtime/types";

interface FeaturebaseFeedbackVisibilityInput {
	selectedAgentId?: RuntimeAgentId | null;
	featurebaseFeedbackState?: FeaturebaseFeedbackState;
}

export function canShowFeaturebaseFeedbackButton(_input: FeaturebaseFeedbackVisibilityInput): boolean {
	// Featurebase JWT authentication flow is not currently available.
	return false;
}

interface FeaturebaseFeedbackButtonProps extends FeaturebaseFeedbackVisibilityInput {
	size?: "sm" | "md";
	variant?: "default" | "primary" | "danger" | "ghost";
	className?: string;
	onClick?: React.MouseEventHandler<HTMLButtonElement>;
}

export function FeaturebaseFeedbackButton({
	selectedAgentId,
	featurebaseFeedbackState,
	size = "sm",
	variant = "default",
	className,
	onClick,
}: FeaturebaseFeedbackButtonProps): React.ReactElement | null {
	if (
		!canShowFeaturebaseFeedbackButton({
			selectedAgentId,
			featurebaseFeedbackState,
		})
	) {
		return null;
	}

	const isOpening = featurebaseFeedbackState?.authState === "loading";

	return (
		<Button size={size} variant={variant} className={className} onClick={onClick} disabled={isOpening}>
			{isOpening ? "Opening..." : "Send feedback"}
		</Button>
	);
}
