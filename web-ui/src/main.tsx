import ReactDOM from "react-dom/client";
import { Toaster } from "sonner";

import App from "@/App";
import { AppErrorBoundary } from "@/components/app";
import { resolveBrowserSurface } from "@/components/compare-window/compare-window-bootstrap";
import { CompareWindowError, CompareWindowRoot } from "@/components/compare-window/compare-window-root";
import { TooltipProvider } from "@/components/ui/tooltip";
import { initializeBrowserDiagnostics, recordBrowserLog } from "@/diagnostics";
import { getRuntimeEnvironment } from "@/runtime/runtime-environment";
import { installGlobalErrorCapture, setGlobalErrorCallback } from "@/utils/global-error-capture";
import { createUnexpectedErrorNotifier } from "@/utils/unexpected-error-notification";
import "@/styles/globals.css";

// Reject ordinary browser documents before any runtime or renderer initialization.
getRuntimeEnvironment();
initializeBrowserDiagnostics();
setGlobalErrorCallback(recordBrowserLog);
installGlobalErrorCapture(createUnexpectedErrorNotifier());

const root = document.getElementById("root");
if (!root) {
	throw new Error("Root element was not found.");
}

const surface = resolveBrowserSurface(new URL(window.location.href));

ReactDOM.createRoot(root).render(
	<AppErrorBoundary>
		<TooltipProvider>
			{surface.kind === "app" ? (
				<App />
			) : surface.kind === "compare" ? (
				<CompareWindowRoot target={surface.target} />
			) : (
				<CompareWindowError message="This Compare window target is invalid. Open a new comparison from Git." />
			)}
			<Toaster
				theme="dark"
				position="bottom-right"
				toastOptions={{
					style: {
						background: "var(--color-surface-1)",
						border: "1px solid var(--color-border)",
						color: "var(--color-text-primary)",
						fontSize: "13px",
						whiteSpace: "pre-line",
					},
				}}
			/>
		</TooltipProvider>
	</AppErrorBoundary>,
);
