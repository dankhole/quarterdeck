import { type ReactElement, type ReactNode, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { BrowserDiagnosticsState } from "@/diagnostics";
import { useInterval } from "@/utils/react-use";

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
	return (
		<section className="rounded-md border border-border bg-surface-1 p-3">
			<h3 className="mb-2 text-xs font-semibold text-text-primary">{title}</h3>
			{children}
		</section>
	);
}

function ValueRow({ label, value }: { label: string; value: ReactNode }): ReactElement {
	return (
		<div className="flex items-start justify-between gap-3 py-0.5 text-xs">
			<span className="text-text-tertiary">{label}</span>
			<span className="break-all text-right font-mono text-text-secondary">{value}</span>
		</div>
	);
}

export function DiagnosticsHealth({ state }: { state: BrowserDiagnosticsState }): ReactElement {
	const data = state.remoteData;
	return (
		<div className="flex flex-col gap-2 overflow-y-auto p-3">
			<Section title="Connection">
				<ValueRow label="Browser stream" value={state.connected ? "connected" : "disconnected"} />
				<ValueRow label="Runtime instance" value={state.runtimeInstanceId ?? "unavailable"} />
				<ValueRow label="Pending browser records" value={state.pendingCount} />
				{state.lastTransportError ? (
					<p className="mt-2 text-xs text-status-red">{state.lastTransportError}</p>
				) : null}
			</Section>
			<Section title="Recorder">
				{data ? (
					<>
						<ValueRow label="Records in memory" value={data.health.recordCount} />
						<ValueRow label="Journal queue" value={data.health.pendingJournalRecords} />
						<ValueRow label="Journal" value={data.health.journalHealthy ? "healthy" : "degraded"} />
						<ValueRow label="Dropped" value={data.health.droppedRecords} />
						<ValueRow label="Rejected browser records" value={data.health.rejectedBrowserRecords} />
					</>
				) : (
					<p className="text-xs text-text-tertiary">Refresh to collect a live recorder health snapshot.</p>
				)}
			</Section>
			<Section title={`Doctor findings${data ? ` (${data.findings.length})` : ""}`}>
				{data?.findings.length ? (
					<div className="flex flex-col gap-2">
						{data.findings.map((finding) => (
							<div
								key={`${finding.code}:${finding.observedAt}`}
								className="rounded border border-border bg-surface-0 p-2"
							>
								<div className="flex items-center gap-2">
									<span
										className={
											finding.severity === "error"
												? "text-status-red"
												: finding.severity === "warn"
													? "text-status-orange"
													: "text-status-blue"
										}
									>
										{finding.severity.toUpperCase()}
									</span>
									<span className="font-mono text-[10px] text-text-tertiary">{finding.code}</span>
								</div>
								<p className="mt-1 text-xs font-medium text-text-primary">{finding.summary}</p>
								<p className="mt-1 text-xs text-text-secondary">{finding.explanation}</p>
							</div>
						))}
					</div>
				) : (
					<p className="text-xs text-text-tertiary">
						{data ? "No current findings." : "Refresh to run the diagnostic checks."}
					</p>
				)}
			</Section>
		</div>
	);
}

export function DiagnosticsSystem({ state }: { state: BrowserDiagnosticsState }): ReactElement {
	const providers = state.remoteData?.snapshot.providers ?? [];
	return (
		<div className="flex flex-col gap-2 overflow-y-auto p-3">
			{providers.length ? (
				providers.map((provider) => (
					<Section key={provider.name} title={provider.name}>
						<ValueRow label="Status" value={provider.status} />
						<ValueRow label="Duration" value={`${Math.round(provider.durationMs)} ms`} />
						{provider.error ? <p className="mt-2 text-xs text-status-red">{provider.error}</p> : null}
						{provider.data !== undefined ? (
							<pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-0 p-2 text-[10px] text-text-secondary">
								{JSON.stringify(provider.data, null, 2)}
							</pre>
						) : null}
					</Section>
				))
			) : (
				<div className="flex h-full items-center justify-center text-xs text-text-tertiary">
					Refresh to collect live subsystem snapshots.
				</div>
			)}
		</div>
	);
}

export function DiagnosticsCapture({
	state,
	isExporting,
	isChangingRecording,
	onExport,
	onStartRecording,
	onStopRecording,
}: {
	state: BrowserDiagnosticsState;
	isExporting: boolean;
	isChangingRecording: boolean;
	onExport: () => void;
	onStartRecording: () => void;
	onStopRecording: () => void;
}): ReactElement {
	const recording = state.recording;
	const [now, setNow] = useState(Date.now);
	useEffect(() => setNow(Date.now()), [recording.expiresAt]);
	useInterval(() => setNow(Date.now()), recording.active && recording.expiresAt !== null ? 1_000 : null);
	const expiresInSeconds =
		recording.active && recording.expiresAt ? Math.max(0, Math.ceil((recording.expiresAt - now) / 1_000)) : null;
	const isAgentLabRecording = recording.active && recording.expiresAt === null;
	return (
		<div className="flex flex-col gap-2 overflow-y-auto p-3">
			<Section title="Always-on flight recorder">
				<p className="text-xs leading-relaxed text-text-secondary">
					Quarterdeck continuously retains a bounded, redacted diagnostic timeline and runtime snapshots. It does
					not capture terminal text, task text, file contents, Git diffs, credentials, or historical pixels by
					default.
				</p>
			</Section>
			<Section title="Deep recording">
				<p className="mb-3 text-xs leading-relaxed text-text-secondary">
					Temporarily admits higher-volume diagnostic events for a bounded two-minute window. This is independent
					of console verbosity and automatically expires.
				</p>
				<ValueRow
					label="Status"
					value={
						isAgentLabRecording
							? "active for isolated lab run"
							: recording.active
								? `active (${expiresInSeconds ?? 0}s remaining)`
								: "inactive"
					}
				/>
				<div className="mt-3">
					{isAgentLabRecording ? (
						<p className="text-xs text-text-tertiary">
							Rich capture ends automatically when the disposable lab stops.
						</p>
					) : recording.active ? (
						<Button
							variant="danger"
							size="sm"
							disabled={isChangingRecording}
							onClick={onStopRecording}
							icon={isChangingRecording ? <Spinner size={12} /> : undefined}
						>
							Stop deep recording
						</Button>
					) : (
						<Button
							variant="default"
							size="sm"
							disabled={!state.connected || isChangingRecording}
							onClick={onStartRecording}
							icon={isChangingRecording ? <Spinner size={12} /> : undefined}
						>
							Record for 2 minutes
						</Button>
					)}
				</div>
			</Section>
			<Section title="Export bundle">
				<p className="mb-3 text-xs leading-relaxed text-text-secondary">
					Writes an atomic, checksummed bundle containing the timeline, doctor findings, runtime health, and a
					fresh metadata-only browser snapshot. The bundle remains local to this machine.
				</p>
				<Button
					variant="primary"
					size="sm"
					disabled={!state.connected || isExporting}
					onClick={onExport}
					icon={isExporting ? <Spinner size={12} /> : undefined}
				>
					Export diagnostic bundle
				</Button>
			</Section>
		</div>
	);
}
