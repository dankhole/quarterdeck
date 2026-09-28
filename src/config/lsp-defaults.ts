import type { LspServerConfig } from "../core/api/code-navigation";

export const DEFAULT_LSP_SERVERS: LspServerConfig[] = [
	{
		id: "typescript",
		label: "TypeScript / JavaScript",
		enabled: true,
		command: "typescript-language-server",
		args: ["--stdio"],
		extensions: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
		rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
	},
];
