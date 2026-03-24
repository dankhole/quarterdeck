import * as Sentry from "@sentry/react";

const sentryDsn = "https://061e8f494493d1cf3c7c918563cc0783@o4511098366263296.ingest.us.sentry.io/4511098568769536";
const sentryEnvironment = import.meta.env.MODE;

let initialized = false;

export function initializeSentry(): void {
	if (!sentryDsn || initialized) {
		return;
	}

	Sentry.init({
		dsn: sentryDsn,
		environment: sentryEnvironment,
		release: `kanban@${__APP_VERSION__}`,
		sendDefaultPii: false,
		initialScope: {
			tags: {
				app: "kanban",
				runtime_surface: "web",
			},
		},
	});

	initialized = true;
}

export function isSentryEnabled(): boolean {
	return initialized;
}
