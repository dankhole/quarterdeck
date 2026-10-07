import { RefreshCw, Unplug } from "lucide-react";
import type { ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { RUNTIME_ADMISSION_REQUIRED_MESSAGE } from "@/runtime/runtime-client-admission";
import { getRuntimeEnvironment } from "@/runtime/runtime-environment";

export function RuntimeDisconnectedFallback({
	message,
	presentation = "page",
}: {
	message?: string;
	presentation?: "page" | "banner";
}): ReactElement {
	const desktop = getRuntimeEnvironment().kind === "desktop";
	const requiresAdmission = message === RUNTIME_ADMISSION_REQUIRED_MESSAGE;
	const canReload = !desktop && (!requiresAdmission || import.meta.env.DEV);
	return (
		<div
			role={presentation === "banner" ? "status" : undefined}
			className={
				presentation === "banner"
					? "pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center p-3 text-text-primary"
					: "min-h-screen bg-surface-0 text-text-primary flex items-center justify-center p-6"
			}
		>
			<div className="w-full max-w-xl rounded-xl border border-border bg-surface-1 p-4 shadow-2xl">
				<div className="flex items-center gap-3 text-text-primary">
					<div className="flex h-10 w-10 items-center justify-center rounded-lg border border-text-tertiary/30 bg-text-tertiary/10 text-text-tertiary">
						<Unplug size={18} />
					</div>
					<div>
						<h1 className="text-lg font-semibold">
							{requiresAdmission ? "Reopen Quarterdeck to connect" : "Disconnected from Quarterdeck"}
						</h1>
						<p className="mt-1 text-sm text-text-secondary">
							{message ??
								(desktop
									? "Waiting for the runtime to reconnect."
									: "Waiting for the server to reconnect. If it stopped, start it again in your terminal.")}
						</p>
					</div>
				</div>
				<div className="mt-5">
					<p className="mb-3 text-sm text-text-secondary">
						{desktop
							? "Local drafts remain available to review or save a copy. Use File > Restart Runtime when the runtime is unavailable. View > Reload Window becomes available after it reconnects and checks drafts before reloading."
							: requiresAdmission
								? import.meta.env.DEV
									? "Reload the development app to renew its session. Reloading discards unsaved changes."
									: "Keep this page open to preserve unsaved changes. Refreshing this page does not renew your session."
								: "Reloading the page discards unsaved changes. You can wait here to reconnect automatically."}
					</p>
					{canReload && (
						<Button
							size="md"
							variant="primary"
							className="h-auto min-h-8 whitespace-normal py-1.5"
							icon={<RefreshCw size={16} />}
							onClick={() => {
								window.location.reload();
							}}
						>
							{requiresAdmission ? "Reload development app" : "Reload page"}
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}
