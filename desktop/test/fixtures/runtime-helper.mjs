import { randomUUID } from "node:crypto";

process.on("message", (message) => {
	if (message.type === "quarterdeck:desktop-startup") {
		if (process.env.DESKTOP_FIXTURE_MODE === "ownership-failure") {
			process.send({
				type: "quarterdeck:desktop-failed",
				protocolVersion: 1,
				startupId: message.startupId,
				code: "recovery_custody_unconfirmed",
				message: "Synthetic private error text",
			});
			return;
		}
		process.send({
			type: "quarterdeck:desktop-ready",
			protocolVersion: 1,
			startupId: process.env.DESKTOP_FIXTURE_MODE === "wrong-startup" ? randomUUID() : message.startupId,
			runtimeOrigin: "http://127.0.0.1:12345",
			runtimeGeneration: randomUUID(),
			instanceId: "fixture",
			diagnosticInstanceId: process.env.DESKTOP_FIXTURE_MODE === "attached-exit" ? null : randomUUID(),
			browserProtocolVersion: Number(process.env.DESKTOP_FIXTURE_BROWSER_PROTOCOL),
			packageVersion: "0.12.8",
			desktopBridgeVersion: 1,
			desktopTransportVersion: 1,
			ownership: process.env.DESKTOP_FIXTURE_MODE === "attached-exit" ? "attached" : "owned",
		});
		if (["unexpected-exit", "attached-exit"].includes(process.env.DESKTOP_FIXTURE_MODE))
			setTimeout(() => process.exit(1), 20);
	}
	if (message.type === "quarterdeck:desktop-control") {
		if (process.env.DESKTOP_FIXTURE_MODE === "control-timeout") return;
		const response = {
			type: "quarterdeck:desktop-control-result",
			protocolVersion: 1,
			startupId: message.startupId,
			requestId: message.requestId,
			result: { method: "get-quit-summary", owned: true, liveProcessCount: 2, pendingLaunches: false },
		};
		process.send({ ...response, requestId: randomUUID() });
		if (message.method === "create-browser-launch")
			response.result = {
				method: "create-browser-launch",
				url: `http://127.0.0.1:12345/api/runtime/client-bootstrap?capability=${"a".repeat(43)}`,
			};
		process.send(response);
	}
	if (message.type === "quarterdeck:desktop-shutdown") {
		if (process.env.DESKTOP_FIXTURE_MODE === "no-ack") {
			process.exit(0);
			return;
		}
		const result = {
			type: "quarterdeck:desktop-shutdown-result",
			protocolVersion: 1,
			startupId: message.startupId,
			requestId: message.requestId,
			outcome: { status: "clean", safeToExit: true, safeToReleaseOwnership: true },
		};
		if (process.env.DESKTOP_FIXTURE_MODE === "incomplete") {
			result.outcome = {
				status: "incomplete",
				safeToExit: false,
				safeToReleaseOwnership: false,
				reasons: ["persistence_failed"],
			};
			process.send(result);
			return;
		}
		process.send(result, () => process.exit(0));
	}
});
process.on("disconnect", () => process.exit(0));
