export const DEFAULT_QUARTERDECK_RUNTIME_HOST = "127.0.0.1";
export const DEFAULT_QUARTERDECK_RUNTIME_PORT = 3484;

let runtimeHost: string = process.env.QUARTERDECK_RUNTIME_HOST?.trim() || DEFAULT_QUARTERDECK_RUNTIME_HOST;

export function getQuarterdeckRuntimeHost(): string {
	return runtimeHost;
}

export function setQuarterdeckRuntimeHost(host: string): void {
	runtimeHost = host;
	process.env.QUARTERDECK_RUNTIME_HOST = host;
}

export function parseRuntimePort(rawPort: string | undefined): number {
	if (!rawPort) {
		return DEFAULT_QUARTERDECK_RUNTIME_PORT;
	}
	const parsed = Number.parseInt(rawPort, 10);
	if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
		throw new Error(`Invalid QUARTERDECK_RUNTIME_PORT value "${rawPort}". Expected an integer from 1-65535.`);
	}
	return parsed;
}

let runtimePort = parseRuntimePort(process.env.QUARTERDECK_RUNTIME_PORT?.trim());

export function getQuarterdeckRuntimePort(): number {
	return runtimePort;
}

export function setQuarterdeckRuntimePort(port: number): void {
	const normalized = parseRuntimePort(String(port));
	runtimePort = normalized;
	process.env.QUARTERDECK_RUNTIME_PORT = String(normalized);
}

export function getQuarterdeckRuntimeOrigin(): string {
	return `http://${getQuarterdeckRuntimeHost()}:${getQuarterdeckRuntimePort()}`;
}

export function getQuarterdeckRuntimeWsOrigin(): string {
	return `ws://${getQuarterdeckRuntimeHost()}:${getQuarterdeckRuntimePort()}`;
}

export function buildQuarterdeckRuntimeUrl(pathname: string): string {
	const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
	return `${getQuarterdeckRuntimeOrigin()}${normalizedPath}`;
}

export function buildQuarterdeckRuntimeWsUrl(pathname: string): string {
	const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
	return `${getQuarterdeckRuntimeWsOrigin()}${normalizedPath}`;
}
