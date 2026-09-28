import { CONFIG_DEFAULTS } from "@runtime-config-defaults";
import { Plus, RotateCcw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { SettingsSwitch } from "@/components/ui/settings-controls";
import {
	createLspServerFormValues,
	type LspServerFormValues,
	parseLspServerForm,
} from "@/hooks/settings/lsp-server-form";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { LspServerConfig } from "@/runtime/types";
import { toErrorMessage } from "@/utils/to-error-message";
import type { SettingsSectionProps } from "./settings-section-props";

const SERVER_FIELDS = [
	{ key: "id", label: "Server ID", placeholder: "typescript" },
	{ key: "label", label: "Display name", placeholder: "TypeScript / JavaScript" },
	{ key: "command", label: "Executable", placeholder: "typescript-language-server" },
	{ key: "args", label: "Arguments (JSON array)", placeholder: '["--stdio"]' },
	{ key: "extensions", label: "File extensions (comma separated)", placeholder: ".ts, .tsx, .js, .jsx" },
	{ key: "rootMarkers", label: "Root markers (comma separated)", placeholder: "tsconfig.json, package.json" },
] as const;

function commandCheckKey(server: LspServerConfig): string {
	return JSON.stringify([server.command, Object.entries(server.env ?? {})]);
}

function ServerEditor({
	server,
	onApply,
	onClose,
	existingIds,
}: {
	server: LspServerConfig;
	onApply: (server: LspServerConfig) => void;
	onClose: () => void;
	existingIds: readonly string[];
}): React.ReactElement {
	const [draft, setDraft] = useState<LspServerFormValues>(() => createLspServerFormValues(server));
	const [error, setError] = useState<string | null>(null);
	const apply = () => {
		const parsed = parseLspServerForm(draft);
		if (parsed.error !== null) {
			setError(parsed.error);
			return;
		}
		if (existingIds.includes(parsed.server.id)) {
			setError("A language server with that ID already exists.");
			return;
		}
		onApply(parsed.server);
	};
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogHeader title="Language server" />
			<DialogBody>
				<p className="mt-0 mb-3 text-[13px] text-text-secondary">
					Use an installed executable or an absolute executable path. Arguments are passed directly, without a
					shell.
				</p>
				<SettingsSwitch
					disabled={false}
					checked={draft.enabled}
					onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
					label="Enable this server"
				/>
				{SERVER_FIELDS.map(({ key, label, placeholder }) => (
					<label key={key} className="block mt-3 text-[13px] text-text-primary">
						{label}
						<input
							value={draft[key]}
							onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
							placeholder={placeholder}
							spellCheck={false}
							className="mt-1 w-full rounded-md border border-border bg-surface-2 px-2 py-1.5 font-mono text-xs focus:border-border-focus focus:outline-none"
						/>
					</label>
				))}
				<label className="block mt-3 text-[13px] text-text-primary">
					Initialization options (optional JSON)
					<textarea
						rows={3}
						value={draft.initializationOptions}
						onChange={(event) => setDraft({ ...draft, initializationOptions: event.target.value })}
						spellCheck={false}
						className="mt-1 w-full rounded-md border border-border bg-surface-2 px-2 py-1.5 font-mono text-xs focus:border-border-focus focus:outline-none"
					/>
				</label>
				<label className="block mt-3 text-[13px] text-text-primary">
					Environment variables (optional JSON object)
					<textarea
						rows={2}
						value={draft.env}
						onChange={(event) => setDraft({ ...draft, env: event.target.value })}
						spellCheck={false}
						className="mt-1 w-full rounded-md border border-border bg-surface-2 px-2 py-1.5 font-mono text-xs focus:border-border-focus focus:outline-none"
					/>
				</label>
				{error ? (
					<p role="alert" className="mb-0 text-xs text-status-red">
						{error}
					</p>
				) : null}
			</DialogBody>
			<DialogFooter>
				<Button onClick={onClose}>Cancel</Button>
				<Button variant="primary" onClick={apply}>
					Apply server
				</Button>
			</DialogFooter>
		</Dialog>
	);
}

export function CodeNavigationSection({
	fields,
	setField,
	disabled,
	projectId,
}: SettingsSectionProps & { projectId: string | null }): React.ReactElement {
	const [editing, setEditing] = useState<{ index: number | null; server: LspServerConfig } | null>(null);
	const [commandChecks, setCommandChecks] = useState<Record<string, string>>({});
	const checkCommand = async (server: LspServerConfig) => {
		const key = commandCheckKey(server);
		setCommandChecks((current) => ({ ...current, [key]: "Checking executable…" }));
		try {
			const result = await getRuntimeTrpcClient(projectId).runtime.checkLspCommand.query({
				command: server.command,
				env: server.env,
			});
			setCommandChecks((current) => ({ ...current, [key]: result.message }));
		} catch (error) {
			setCommandChecks((current) => ({ ...current, [key]: toErrorMessage(error) }));
		}
	};
	const addServer = () => {
		let index = 1;
		while (fields.lspServers.some((server) => server.id === `custom-${index}`)) index += 1;
		setEditing({
			index: null,
			server: {
				id: `custom-${index}`,
				label: "Custom server",
				enabled: true,
				command: "",
				args: [],
				extensions: [],
				rootMarkers: [],
			},
		});
	};
	return (
		<section aria-labelledby="code-navigation-settings-heading" className="mt-4">
			<h6 id="code-navigation-settings-heading" className="font-semibold text-text-primary mb-2">
				Code Navigation
			</h6>
			<SettingsSwitch
				checked={fields.codeNavigationEnabled}
				onCheckedChange={(value) => setField("codeNavigationEnabled", value)}
				disabled={disabled}
				label="Enable code navigation"
				description="Use your installed language servers for definitions, references, and type information in live Files workspaces. Servers start when you request navigation."
			/>
			<div className="mt-3 space-y-2">
				{fields.lspServers.map((server, index) => (
					<div key={server.id} className="rounded-md border border-border p-3">
						<div className="flex flex-wrap items-center gap-2">
							<span className="flex-1 text-[13px] text-text-primary">
								{server.label}{" "}
								<span className="text-xs text-text-tertiary">{server.enabled ? "Enabled" : "Disabled"}</span>
							</span>
							<Button size="sm" disabled={disabled} onClick={() => setEditing({ index, server })}>
								Edit
							</Button>
							<Button
								size="sm"
								disabled={disabled}
								onClick={() =>
									setField(
										"lspServers",
										fields.lspServers.filter((_, serverIndex) => serverIndex !== index),
									)
								}
							>
								Remove
							</Button>
						</div>
						<p className="my-1 break-all font-mono text-xs text-text-secondary">
							{server.command} {server.args.map((arg) => JSON.stringify(arg)).join(" ")}
						</p>
						<p className="my-1 text-xs text-text-tertiary">{server.extensions.join(", ")}</p>
						<div className="mt-2 flex flex-wrap items-center gap-2">
							<Button
								size="sm"
								disabled={disabled || commandChecks[commandCheckKey(server)] === "Checking executable…"}
								onClick={() => void checkCommand(server)}
							>
								Check command
							</Button>
							<span role="status" className="text-xs text-text-secondary">
								{commandChecks[commandCheckKey(server)] ?? "Command availability has not been checked."}
							</span>
						</div>
					</div>
				))}
			</div>
			<div className="mt-2 flex flex-wrap gap-2">
				<Button
					size="sm"
					icon={<Plus size={14} />}
					disabled={disabled || fields.lspServers.length >= 20}
					onClick={addServer}
				>
					Add language server
				</Button>
				<Button
					size="sm"
					icon={<RotateCcw size={14} />}
					disabled={disabled}
					onClick={() => setField("lspServers", structuredClone(CONFIG_DEFAULTS.lspServers))}
				>
					Restore default templates
				</Button>
			</div>
			<p className="mb-0 text-xs text-text-secondary">
				Quarterdeck does not install language servers. Check command verifies the executable without starting it.
				Changes take effect after Save.
			</p>
			{editing ? (
				<ServerEditor
					server={editing.server}
					existingIds={fields.lspServers.filter((_, index) => index !== editing.index).map((server) => server.id)}
					onClose={() => setEditing(null)}
					onApply={(server) => {
						setField(
							"lspServers",
							editing.index === null
								? [...fields.lspServers, server]
								: fields.lspServers.map((current, index) => (index === editing.index ? server : current)),
						);
						setEditing(null);
					}}
				/>
			) : null}
		</section>
	);
}
