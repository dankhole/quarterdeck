import { useCallback, useEffect, useRef, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import { browserHostIntegrations } from "@/runtime/browser-host-integrations";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";

export function useCopyConversation(projectId: string | null, taskId: string | null, sessionInstanceId: string | null) {
	const [isCopying, setIsCopying] = useState(false);
	const pending = useRef<AbortController | null>(null);
	useEffect(() => {
		setIsCopying(false);
		return () => {
			pending.current?.abort();
			pending.current = null;
		};
	}, [projectId, taskId, sessionInstanceId]);

	const copyConversation = useCallback(async () => {
		if (!projectId || !taskId || !sessionInstanceId || pending.current) return;
		const controller = new AbortController();
		pending.current = controller;
		setIsCopying(true);
		let readError: string | null = null;
		const text = getRuntimeTrpcClient(projectId)
			.runtime.readTaskConversation.query({ taskId, sessionInstanceId }, { signal: controller.signal })
			.then((result) => {
				if (controller.signal.aborted) throw new Error("Copy cancelled");
				if (!result.ok) {
					readError = result.error;
					throw new Error(result.error);
				}
				return result.text;
			})
			.catch((error: unknown) => {
				readError ??= "Could not read the full Codex conversation. Try again.";
				throw error;
			});
		try {
			await browserHostIntegrations.writeClipboardText(text);
			if (!controller.signal.aborted) showAppToast({ intent: "success", message: "Full conversation copied." });
		} catch {
			if (!controller.signal.aborted)
				showAppToast({
					intent: "danger",
					message: readError ?? "Could not copy the conversation. Check clipboard permissions and try again.",
				});
		} finally {
			controller.abort();
			if (pending.current === controller) {
				pending.current = null;
				setIsCopying(false);
			}
		}
	}, [projectId, taskId, sessionInstanceId]);
	return { isCopying, copyConversation };
}
