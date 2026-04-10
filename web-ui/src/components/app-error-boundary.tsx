import { RefreshCw, RotateCcw, TriangleAlert } from "lucide-react";
import { Component, type ErrorInfo, type ReactElement, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { RuntimeDisconnectedFallback } from "@/hooks/runtime-disconnected-fallback";
import { isRuntimeDisconnected } from "@/runtime/runtime-connection-state";

function AppErrorFallback({ error, resetError }: { error: unknown; resetError: () => void }): ReactElement {
	if (isRuntimeDisconnected()) {
		return <RuntimeDisconnectedFallback />;
	}

	const message = error instanceof Error ? error.message : "Quarterdeck hit an unexpected UI error.";

	return (
		<div className="min-h-screen bg-surface-0 text-text-primary flex items-center justify-center p-6">
			<div className="w-full max-w-lg rounded-xl border border-border bg-surface-1 p-6 shadow-2xl">
				<div className="flex items-center gap-3 text-text-primary">
					<div className="flex h-10 w-10 items-center justify-center rounded-lg border border-status-red/30 bg-status-red/10 text-status-red">
						<TriangleAlert size={18} />
					</div>
					<div>
						<h1 className="text-lg font-semibold">Quarterdeck hit an unexpected UI error.</h1>
						<p className="mt-1 text-sm text-text-secondary">
							You can try rendering the app again or reload the page.
						</p>
					</div>
				</div>
				<div className="mt-4 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text-secondary">
					{message}
				</div>
				<div className="mt-5 flex flex-wrap gap-2">
					<Button size="md" variant="default" icon={<RotateCcw size={16} />} onClick={resetError}>
						Try again
					</Button>
					<Button
						size="md"
						variant="primary"
						icon={<RefreshCw size={16} />}
						onClick={() => {
							window.location.reload();
						}}
					>
						Reload page
					</Button>
				</div>
			</div>
		</div>
	);
}

interface AppErrorBoundaryProps {
	children: ReactNode;
}

interface AppErrorBoundaryState {
	error: unknown | null;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
	state: AppErrorBoundaryState = { error: null };

	static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
		return { error };
	}

	componentDidCatch(error: unknown, _info: ErrorInfo): void {
		console.error("[AppErrorBoundary]", error);
	}

	resetError = (): void => {
		this.setState({ error: null });
	};

	render(): ReactNode {
		if (this.state.error !== null) {
			return <AppErrorFallback error={this.state.error} resetError={this.resetError} />;
		}
		return this.props.children;
	}
}
