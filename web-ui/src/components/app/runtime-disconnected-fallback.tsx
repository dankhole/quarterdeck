import { Unplug } from "lucide-react";
import type { ReactElement } from "react";

import { RUNTIME_ADMISSION_REQUIRED_MESSAGE } from "@/runtime/runtime-client-admission";

export function RuntimeDisconnectedFallback({
	message,
	presentation = "page",
}: {
	message?: string;
	presentation?: "page" | "banner";
}): ReactElement {
	const requiresAdmission = message === RUNTIME_ADMISSION_REQUIRED_MESSAGE;
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
							{message ?? "Waiting for the runtime to reconnect."}
						</p>
					</div>
				</div>
				<p className="mt-5 text-sm text-text-secondary">
					Local drafts remain available to review or save a copy. Use File &gt; Restart Runtime when the runtime is
					unavailable. View &gt; Reload Window becomes available after it reconnects and checks drafts before
					reloading.
				</p>
			</div>
		</div>
	);
}
