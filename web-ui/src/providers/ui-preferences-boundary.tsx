import type { RuntimeAppRouter } from "@runtime-trpc";
import { isTRPCClientError } from "@trpc/client";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { getOptionalLocalStorage } from "@/storage/local-storage-store";
import { collectLegacyUiPreferences, sharedUiPreferences } from "@/storage/shared-ui-preferences";

/** All preference consumers mount after runtime hydration and legacy seeding. */
export function UiPreferencesBoundary({ children }: { children: ReactNode }): ReactNode {
	const [ready, setReady] = useState(sharedUiPreferences.active);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		if (ready) return;
		let mounted = true;
		const client = getRuntimeTrpcClient(null);
		void sharedUiPreferences
			.initialize(
				{
					read: () => client.runtime.getUiPreferences.query(),
					patch: (patch) => client.runtime.patchUiPreferences.mutate(patch),
				},
				collectLegacyUiPreferences(getOptionalLocalStorage()),
				() => {
					toast.error(
						"Could not save the shared UI preference. Check the runtime connection and try the change again.",
					);
				},
			)
			.then(() => {
				if (mounted) setReady(true);
			})
			.catch((cause: unknown) => {
				if (!mounted) return;
				setError(
					isTRPCClientError<RuntimeAppRouter>(cause) && cause.data?.code === "NOT_FOUND"
						? "This Quarterdeck runtime does not support shared UI preferences. Restart Quarterdeck and refresh this page."
						: cause instanceof Error
							? cause.message
							: "Could not load shared UI preferences.",
				);
			});
		return () => {
			mounted = false;
		};
	}, [attempt, ready]);
	if (ready) return children;
	return (
		<div className="flex h-[100svh] flex-col items-center justify-center gap-3 bg-surface-0 p-6 text-text-primary">
			{error ? (
				<>
					<p role="alert">Could not load shared UI preferences: {error}</p>
					<Button
						onClick={() => {
							setError(null);
							setAttempt((value) => value + 1);
						}}
					>
						Try again
					</Button>
				</>
			) : (
				<>
					<Spinner />
					<p>Loading preferences…</p>
				</>
			)}
		</div>
	);
}
