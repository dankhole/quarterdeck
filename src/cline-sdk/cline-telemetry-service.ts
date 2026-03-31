import * as os from "node:os";
import { type BasicLogger, createClineTelemetryServiceMetadata, type ITelemetryService } from "@clinebot/shared";
import packageJson from "../../package.json" with { type: "json" };
import { LoggerTelemetryAdapter, TelemetryService } from "./sdk-runtime-boundary.js";

const appVersion = typeof packageJson.version === "string" ? packageJson.version : "0.1.0";

let telemetrySingleton:
	| {
			telemetry: TelemetryService;
			loggerAttached: boolean;
	  }
	| undefined;

export function getCliTelemetryService(logger?: BasicLogger): ITelemetryService {
	if (!telemetrySingleton) {
		const metadata = createClineTelemetryServiceMetadata({
			extension_version: appVersion,
			cline_type: "kanban",
			platform: "kanban",
			platform_version: process.version,
			os_type: os.platform(),
			os_version: os.version(),
		});
		const telemetry = new TelemetryService({ metadata, logger });
		telemetrySingleton = {
			telemetry,
			loggerAttached: Boolean(logger),
		};
	}
	if (logger && telemetrySingleton.loggerAttached !== true) {
		telemetrySingleton.telemetry.addAdapter(new LoggerTelemetryAdapter({ logger }));
		telemetrySingleton.loggerAttached = true;
	}
	return telemetrySingleton.telemetry;
}

export async function disposeCliTelemetryService(): Promise<void> {
	if (!telemetrySingleton) {
		return;
	}
	const current = telemetrySingleton;
	telemetrySingleton = undefined;
	await current.telemetry.dispose();
}
