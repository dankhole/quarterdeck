import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createProtocolConnection, DefinitionRequest, DidCloseTextDocumentNotification, DidOpenTextDocumentNotification, ExitNotification, HoverRequest, InitializeRequest, ReferencesRequest, ShutdownRequest } from "vscode-languageserver-protocol/node";

const connection = createProtocolConnection(process.stdin, process.stdout);
const documents = new Map();
const record = (event, fields = {}) => {
	if (process.env.LSP_TEST_EVENTS) appendFileSync(process.env.LSP_TEST_EVENTS, `${JSON.stringify({ event, pid: process.pid, ...fields })}\n`);
};
if (process.env.LSP_TEST_CHILD === "1") {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	record("child", { childPid: child.pid });
}
connection.onRequest(InitializeRequest.type, (params) => {
	record("initialize", { rootUri: params.rootUri });
	if (process.env.LSP_TEST_EXIT_INITIALIZE === "1") process.exit(0);
	if (process.env.LSP_TEST_FLOOD === "1") {
		// Frame the oversized invalid body so this tests process cleanup without
		// quadratic rescanning of an unterminated header in the protocol library.
		process.stdout.write(`Content-Length: ${34 * 1024 * 1024}\r\n\r\n`);
		process.stdout.write(Buffer.alloc(34 * 1024 * 1024, "x"));
	}
	if (process.env.LSP_TEST_OUTPUT_LIMIT === "1") {
		void connection.sendNotification("window/logMessage", { type: 3, message: "x".repeat(34 * 1024 * 1024) }).catch(() => {});
	}
	return { capabilities: { textDocumentSync: { openClose: true, change: 1 }, definitionProvider: true, referencesProvider: true, hoverProvider: true } };
});
connection.onNotification(DidOpenTextDocumentNotification.type, ({ textDocument }) => {
	documents.set(textDocument.uri, textDocument);
	record("open", { version: textDocument.version, content: textDocument.text });
});
connection.onNotification(DidCloseTextDocumentNotification.type, ({ textDocument }) => { documents.delete(textDocument.uri); record("close"); });
const locations = async ({ textDocument }) => {
	const document = documents.get(textDocument.uri);
	if (!document) throw new Error("Document was not synchronized.");
	if (process.env.LSP_TEST_HANG === "1") return await new Promise(() => {});
	if (process.env.LSP_TEST_DELAY) await new Promise((resolve) => setTimeout(resolve, Number(process.env.LSP_TEST_DELAY)));
	const line = Math.max(0, document.text.split("\n").findIndex((value) => value.includes("target")));
	const uri = process.env.LSP_TEST_TARGET_URI || textDocument.uri;
	return [{ uri, range: { start: { line, character: 0 }, end: { line, character: 6 } } }];
};
connection.onRequest(DefinitionRequest.type, locations);
connection.onRequest(ReferencesRequest.type, locations);
connection.onRequest(HoverRequest.type, ({ textDocument }) => ({ contents: { kind: "plaintext", value: documents.get(textDocument.uri)?.text ?? "" } }));
connection.onRequest(ShutdownRequest.type, async () => {
	record("shutdown");
	if (process.env.LSP_TEST_SLOW_SHUTDOWN) await new Promise((resolve) => setTimeout(resolve, Number(process.env.LSP_TEST_SLOW_SHUTDOWN)));
	return null;
});
connection.onNotification(ExitNotification.type, () => process.exit(0));
connection.listen();
