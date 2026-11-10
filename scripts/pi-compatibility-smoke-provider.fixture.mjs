// Loaded by the private native Pi release, never by the test's event dispatcher.
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const audit = (record) => appendFileSync(process.env.PI_SMOKE_AUDIT, `${JSON.stringify(record)}\n`);

export default function syntheticProvider(pi) {
	pi.registerProvider("quarterdeck-smoke", {
		baseUrl: "http://synthetic.invalid",
		apiKey: "synthetic-not-a-credential",
		api: "quarterdeck-smoke",
		models: [
			{
				id: "local",
				name: "Offline smoke",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 1024,
			},
		],
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			const user = context.messages.findLast((message) => message.role === "user");
			const text =
				typeof user?.content === "string"
					? user.content
					: (user?.content
							?.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join("") ?? "");
			const output = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				content: [],
				stopReason: "pending",
				timestamp: Date.now(),
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			void (async () => {
				stream.push({ type: "start", partial: output });
				audit({ type: "model_request", prompt: text });
				if (text === "smoke:hold") {
					await new Promise((resolve) => {
						if (options?.signal?.aborted) resolve();
						else options?.signal?.addEventListener("abort", resolve, { once: true });
					});
					output.stopReason = "aborted";
					output.errorMessage = "Synthetic stream cancelled by native Pi";
					stream.push({ type: "error", reason: "aborted", error: output });
				} else if (text === "smoke:error") {
					output.stopReason = "error";
					output.errorMessage = "Synthetic terminal model failure";
					stream.push({ type: "error", reason: "error", error: output });
				} else if (text === "smoke:tool" && context.messages.at(-1)?.role !== "toolResult") {
					const toolCall = {
						type: "toolCall",
						id: "synthetic-read",
						name: "read",
						arguments: { path: "fixture.txt" },
					};
					output.content.push(toolCall);
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
					output.stopReason = "toolUse";
					stream.push({ type: "done", reason: "toolUse", message: output });
				} else {
					const reply = "Synthetic reply\n\n  preserved indentation";
					output.content.push({ type: "text", text: reply });
					stream.push({ type: "text_start", contentIndex: 0, partial: output });
					stream.push({ type: "text_delta", contentIndex: 0, delta: reply, partial: output });
					stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: output });
					output.stopReason = "stop";
					stream.push({ type: "done", reason: "stop", message: output });
				}
				stream.end();
			})();
			return stream;
		},
	});
	pi.on("input", (event) => {
		audit({ type: "input", text: event.text });
		if (event.text === "smoke:consume") return { action: "handled" };
	});
	pi.on("session_start", (event, ctx) =>
		audit({
			type: event.type,
			reason: event.reason,
			sessionId: ctx.sessionManager.getSessionId(),
			cwd: ctx.cwd,
			trusted: ctx.isProjectTrusted(),
			mode: ctx.mode,
		}),
	);
	pi.on("session_shutdown", (event) => audit({ type: event.type, reason: event.reason }));
	pi.on("agent_start", (event) => audit({ type: event.type }));
	pi.on("agent_end", (event) => audit({ type: event.type }));
	pi.on("agent_settled", (event) => audit({ type: event.type, aborted: event.aborted }));
}
