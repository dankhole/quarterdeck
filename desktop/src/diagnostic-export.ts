import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { writeDiagnosticBundle } from "../../src/diagnostics/bundle.js";
import {
	type CollectedDiagnosticCapture,
	collectDiagnosticCapture,
	diagnosticRuntimeUrl,
	probeRuntimeDiagnosticInstance,
} from "../../src/diagnostics/client.js";
import {
	type DiscoveredRuntimeDiagnosticInstance,
	discoverRuntimeDiagnosticInstances,
} from "../../src/diagnostics/runtime-instance.js";

export interface DesktopDiagnosticExportRuntime {
	/** Diagnostic identity from the helper's verified private readiness message. */
	diagnosticInstanceId: string | null;
	origin: string;
	generation: string;
	ownership: "owned" | "attached";
}

export interface DesktopDiagnosticExportOptions {
	/** Canonical state home and instance identity supplied by main, never by the renderer. */
	stateHome: string;
	desktopInstanceId: string;
	flushDesktop: () => Promise<void>;
	getRuntime: () => DesktopDiagnosticExportRuntime | null;
	chooseParentDirectory: () => Promise<string | null>;
}

export type DesktopDiagnosticExportOutcome =
	| { status: "exported"; path: string; source: "runtime" | "desktop"; partial: boolean }
	| { status: "cancelled" }
	| { status: "failed"; reason: "unavailable" | "export_failed" };

function hasCanonicalJournal(instance: DiscoveredRuntimeDiagnosticInstance, stateHome: string): boolean {
	const directory = join(resolve(stateHome), "diagnostics", "instances", instance.descriptor.runtimeInstanceId);
	return (
		resolve(instance.descriptorPath) === join(directory, "runtime.json") &&
		resolve(instance.descriptor.journalDirectory) === join(directory, "journal")
	);
}

function sameRuntime(first: DesktopDiagnosticExportRuntime, current: DesktopDiagnosticExportRuntime | null): boolean {
	return (
		current?.ownership === "owned" &&
		current.diagnosticInstanceId === first.diagnosticInstanceId &&
		current.origin === first.origin &&
		current.generation === first.generation
	);
}

async function captureOwnedRuntime(
	instances: readonly DiscoveredRuntimeDiagnosticInstance[],
	options: DesktopDiagnosticExportOptions,
): Promise<CollectedDiagnosticCapture | null> {
	const selected = options.getRuntime();
	if (selected?.ownership !== "owned" || selected.diagnosticInstanceId === null) return null;
	const instance = instances.find((candidate) => {
		if (
			candidate.descriptor.processKind !== "runtime" ||
			candidate.descriptor.runtimeInstanceId !== selected.diagnosticInstanceId ||
			!candidate.pidAlive
		)
			return false;
		try {
			return diagnosticRuntimeUrl(candidate.descriptor, "/").origin === selected.origin;
		} catch {
			return false;
		}
	});
	if (!instance) return null;
	const probe = await probeRuntimeDiagnosticInstance(instance);
	if (!probe.reachable || !probe.instanceMatches || !sameRuntime(selected, options.getRuntime())) return null;
	try {
		const capture = await collectDiagnosticCapture(instance);
		if (
			capture.descriptor.processKind !== "runtime" ||
			capture.descriptor.runtimeInstanceId !== instance.descriptor.runtimeInstanceId ||
			!sameRuntime(selected, options.getRuntime())
		)
			return null;
		return capture;
	} catch {
		return null;
	}
}

/** A native intent exports the existing content-safe bundle; downloads and renderer paths are not accepted. */
export function createDesktopDiagnosticExporter(
	options: DesktopDiagnosticExportOptions,
): () => Promise<DesktopDiagnosticExportOutcome> {
	return async () => {
		try {
			const parent = await options.chooseParentDirectory();
			if (parent === null) return { status: "cancelled" };
			if (!isAbsolute(parent)) return { status: "failed", reason: "export_failed" };
			await options.flushDesktop();
			const instances = (await discoverRuntimeDiagnosticInstances(options.stateHome)).filter((instance) =>
				hasCanonicalJournal(instance, options.stateHome),
			);
			const desktop = instances.find(
				(instance) =>
					instance.descriptor.processKind === "desktop" &&
					instance.descriptor.runtimeInstanceId === options.desktopInstanceId,
			);
			if (!desktop) return { status: "failed", reason: "unavailable" };
			const runtimeCapture = await captureOwnedRuntime(instances, options);
			const capture = runtimeCapture ?? (await collectDiagnosticCapture(desktop));
			const source = runtimeCapture ? "runtime" : "desktop";
			const result = await writeDiagnosticBundle({
				...capture,
				quarterdeckVersion: capture.descriptor.quarterdeckVersion,
				stateHome: options.stateHome,
				outputDirectory: join(parent, `quarterdeck-diagnostics-${randomUUID()}`),
			});
			return { status: "exported", path: result.path, source, partial: result.manifest.status === "partial" };
		} catch {
			return { status: "failed", reason: "export_failed" };
		}
	};
}
