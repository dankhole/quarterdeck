import { useEffect, useMemo, useRef, useState } from "react";

import { fetchClineAccountProfile } from "@/runtime/runtime-config-query";
import type { RuntimeClineProviderSettings } from "@/runtime/types";

const FEATUREBASE_SDK_ID = "featurebase-sdk";
const FEATUREBASE_SDK_SRC = "https://do.featurebase.app/js/sdk.js";
const FEATUREBASE_ORGANIZATION = "cline";
const FEATUREBASE_OPEN_RETRY_DELAY_MS = 50;
const FEATUREBASE_OPEN_WIDGET_MESSAGE = {
	target: "FeaturebaseWidget",
	data: {
		action: "openFeedbackWidget",
	},
} as const;

interface FeaturebaseCallbackPayload {
	action?: string;
	[key: string]: unknown;
}

type FeaturebaseCallback = (error: unknown, callback?: FeaturebaseCallbackPayload | null) => void;

interface FeaturebaseCommand {
	(command: string, payload?: unknown, callback?: FeaturebaseCallback): void;
	q?: unknown[][];
}

interface FeaturebaseWindow extends Window {
	Featurebase?: FeaturebaseCommand;
}

interface ClineAccountProfile {
	accountId: string | null;
	email: string | null;
	displayName: string | null;
}

let featurebaseSdkLoadPromise: Promise<void> | null = null;
let isFeaturebaseFeedbackWidgetReady = false;
let isFeaturebaseFeedbackWidgetOpenRequested = false;

function ensureFeaturebaseCommand(win: FeaturebaseWindow): FeaturebaseCommand {
	if (typeof win.Featurebase === "function") {
		return win.Featurebase;
	}
	const queuedCommand: FeaturebaseCommand = (...args: unknown[]) => {
		queuedCommand.q = queuedCommand.q ?? [];
		queuedCommand.q.push(args);
	};
	win.Featurebase = queuedCommand;
	return queuedCommand;
}

function ensureFeaturebaseSdkLoaded(): Promise<void> {
	if (featurebaseSdkLoadPromise) {
		return featurebaseSdkLoadPromise;
	}

	featurebaseSdkLoadPromise = new Promise<void>((resolve, reject) => {
		const existingScript = document.getElementById(FEATUREBASE_SDK_ID) as HTMLScriptElement | null;
		if (existingScript?.dataset.loaded === "true") {
			resolve();
			return;
		}

		const script = existingScript ?? document.createElement("script");
		const handleLoad = () => {
			if (script.dataset) {
				script.dataset.loaded = "true";
			}
			resolve();
		};
		const handleError = () => {
			featurebaseSdkLoadPromise = null;
			reject(new Error("Failed to load Featurebase SDK."));
		};
		script.addEventListener("load", handleLoad, { once: true });
		script.addEventListener("error", handleError, { once: true });
		if (!existingScript) {
			script.id = FEATUREBASE_SDK_ID;
			script.src = FEATUREBASE_SDK_SRC;
			script.async = true;
			document.head.appendChild(script);
			return;
		}
		const existingScriptReadyState = (script as HTMLScriptElement & { readyState?: string }).readyState;
		if (existingScriptReadyState === "complete") {
			handleLoad();
		}
	});

	return featurebaseSdkLoadPromise;
}

function postOpenFeedbackWidgetMessage(): void {
	window.postMessage(FEATUREBASE_OPEN_WIDGET_MESSAGE, "*");
}

function flushFeaturebaseFeedbackWidgetOpenRequest(): void {
	if (!isFeaturebaseFeedbackWidgetOpenRequested || !isFeaturebaseFeedbackWidgetReady) {
		return;
	}
	isFeaturebaseFeedbackWidgetOpenRequested = false;
	postOpenFeedbackWidgetMessage();
	window.setTimeout(() => {
		postOpenFeedbackWidgetMessage();
	}, FEATUREBASE_OPEN_RETRY_DELAY_MS);
}

export function openFeaturebaseFeedbackWidget(): void {
	const win = window as FeaturebaseWindow;
	ensureFeaturebaseCommand(win);
	isFeaturebaseFeedbackWidgetOpenRequested = true;
	void ensureFeaturebaseSdkLoaded()
		.then(() => {
			flushFeaturebaseFeedbackWidgetOpenRequest();
		})
		.catch(() => {
			// Best effort only.
		});
}

export function useFeaturebaseFeedbackWidget(input: {
	workspaceId: string | null;
	clineProviderSettings: RuntimeClineProviderSettings | null;
}): void {
	const { workspaceId, clineProviderSettings } = input;
	const [clineProfile, setClineProfile] = useState<ClineAccountProfile | null>(null);
	const [isClineProfileResolved, setIsClineProfileResolved] = useState(false);
	const lastInitializedSignatureRef = useRef<string | null>(null);
	const isManagedClineOauth =
		clineProviderSettings?.oauthProvider === "cline" && clineProviderSettings.oauthAccessTokenConfigured;

	useEffect(() => {
		if (!isManagedClineOauth) {
			setClineProfile(null);
			setIsClineProfileResolved(true);
			return;
		}
		let cancelled = false;
		setIsClineProfileResolved(false);
		void fetchClineAccountProfile(workspaceId)
			.then((response) => {
				if (cancelled) {
					return;
				}
				setClineProfile(response.profile ?? null);
			})
			.catch(() => {
				if (!cancelled) {
					setClineProfile(null);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setIsClineProfileResolved(true);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [isManagedClineOauth, workspaceId]);

	const clineAccountId = clineProfile?.accountId ?? clineProviderSettings?.oauthAccountId ?? null;
	const metadata = useMemo(() => {
		const nextMetadata: Record<string, string> = {
			app: "kanban",
		};
		if (clineAccountId) {
			nextMetadata.cline_account_id = clineAccountId;
		}
		if (clineProfile?.displayName) {
			nextMetadata.cline_display_name = clineProfile.displayName;
		}
		if (clineProfile?.email) {
			nextMetadata.cline_email = clineProfile.email;
		}
		return nextMetadata;
	}, [clineAccountId, clineProfile?.displayName, clineProfile?.email]);

	const email = clineProfile?.email ?? undefined;
	const displayName = clineProfile?.displayName ?? undefined;
	const shouldIdentifyClineUser = isManagedClineOauth && Boolean(email || clineAccountId);
	const signature = useMemo(
		() =>
			JSON.stringify({
				email: email ?? null,
				displayName: displayName ?? null,
				shouldIdentifyClineUser,
				metadata,
			}),
		[displayName, email, metadata, shouldIdentifyClineUser],
	);

	useEffect(() => {
		const win = window as FeaturebaseWindow;
		ensureFeaturebaseCommand(win);
		let cancelled = false;
		void ensureFeaturebaseSdkLoaded()
			.then(() => {
				if (cancelled || lastInitializedSignatureRef.current === signature) {
					return;
				}
				const featurebase = ensureFeaturebaseCommand(win);
				lastInitializedSignatureRef.current = signature;
				isFeaturebaseFeedbackWidgetReady = false;
				if (shouldIdentifyClineUser) {
					featurebase("identify", {
						organization: FEATUREBASE_ORGANIZATION,
						email,
						name: displayName,
						userId: clineAccountId ?? undefined,
					});
				}
				featurebase(
					"initialize_feedback_widget",
					{
						organization: FEATUREBASE_ORGANIZATION,
						theme: "dark",
						locale: "en",
						email,
						metadata,
					},
					(_error, callback) => {
						if (callback?.action !== "widgetReady") {
							return;
						}
						isFeaturebaseFeedbackWidgetReady = true;
						flushFeaturebaseFeedbackWidgetOpenRequest();
					},
				);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [
		clineAccountId,
		displayName,
		email,
		isClineProfileResolved,
		isManagedClineOauth,
		metadata,
		shouldIdentifyClineUser,
		signature,
	]);
}
