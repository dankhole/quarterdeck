import { createServer } from "node:net";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Resolves an available loopback port without opening a non-loopback listener.
 * The listener is released before returning so the managed child can bind it.
 */
export async function resolveLoopbackPort(requestedPort: number | null, label: string): Promise<number> {
	return await new Promise((resolvePort, rejectPort) => {
		const server = createServer();
		server.once("error", (error) => rejectPort(new Error(`${label} port is unavailable: ${errorMessage(error)}`)));
		server.listen(requestedPort ?? 0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				rejectPort(new Error(`Could not resolve ${label} port.`));
				return;
			}
			const selectedPort = address.port;
			server.close((error) => {
				if (error) rejectPort(error);
				else resolvePort(selectedPort);
			});
		});
	});
}
