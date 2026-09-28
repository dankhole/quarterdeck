import { lspServerConfigSchema } from "@runtime-contract";
import type { LspServerConfig } from "@/runtime/types";

export interface LspServerFormValues {
	id: string;
	label: string;
	enabled: boolean;
	command: string;
	args: string;
	extensions: string;
	rootMarkers: string;
	initializationOptions: string;
	env: string;
}

export function createLspServerFormValues(server: LspServerConfig): LspServerFormValues {
	return {
		...server,
		args: JSON.stringify(server.args),
		extensions: server.extensions.join(", "),
		rootMarkers: server.rootMarkers.join(", "),
		initializationOptions:
			server.initializationOptions === undefined ? "" : JSON.stringify(server.initializationOptions, null, 2),
		env: server.env === undefined ? "" : JSON.stringify(server.env, null, 2),
	};
}

export function parseLspServerForm(
	values: LspServerFormValues,
): { server: LspServerConfig; error: null } | { server: null; error: string } {
	let args: unknown;
	let initializationOptions: unknown;
	let env: unknown;
	try {
		args = JSON.parse(values.args || "[]");
	} catch {
		return { server: null, error: 'Arguments must be a JSON array of strings, for example ["--stdio"].' };
	}
	try {
		initializationOptions = values.initializationOptions.trim()
			? JSON.parse(values.initializationOptions)
			: undefined;
	} catch {
		return { server: null, error: "Initialization options must be valid JSON, or blank." };
	}
	try {
		env = values.env.trim() ? JSON.parse(values.env) : undefined;
	} catch {
		return { server: null, error: "Environment variables must be a JSON object of strings, or blank." };
	}
	const result = lspServerConfigSchema.safeParse({
		...values,
		args,
		extensions: values.extensions
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean),
		rootMarkers: values.rootMarkers
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean),
		initializationOptions,
		env,
	});
	return result.success
		? { server: result.data, error: null }
		: {
				server: null,
				error: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" "),
			};
}
