import {
	AlertTriangle,
	Check,
	CheckCircle,
	GitMerge,
	GitPullRequest,
	Pencil,
	UserCheck,
	Users,
	XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { type DiffLineComment, DiffViewerPanel } from "@/components/detail-panels/diff-viewer-panel";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import type { RuntimeConflictFile, RuntimeConflictState, RuntimeWorkspaceFileChange } from "@/runtime/types";

export interface ConflictResolutionPanelProps {
	conflictState: RuntimeConflictState;
	conflictFiles: RuntimeConflictFile[];
	resolvedFiles: ReadonlySet<string>;
	selectedPath: string | null;
	setSelectedPath: (path: string | null) => void;
	resolveFile: (path: string, resolution: "ours" | "theirs") => Promise<{ ok: boolean; error?: string }>;
	continueResolution: () => Promise<unknown>;
	abortResolution: () => Promise<unknown>;
	isLoading: boolean;
}

function getBasename(filePath: string): string {
	const lastSlash = filePath.lastIndexOf("/");
	return lastSlash === -1 ? filePath : filePath.slice(lastSlash + 1);
}

function ConflictDetailPane({
	selectedPath,
	conflictFiles,
	resolvedFiles,
	resolveFile,
	isLoading,
}: {
	selectedPath: string | null;
	conflictFiles: RuntimeConflictFile[];
	resolvedFiles: ReadonlySet<string>;
	resolveFile: (path: string, resolution: "ours" | "theirs") => Promise<{ ok: boolean; error?: string }>;
	isLoading: boolean;
}): React.ReactElement {
	// No-op comments state for DiffViewerPanel (comments not used in conflict view).
	const [diffComments, setDiffComments] = useState<Map<string, DiffLineComment>>(new Map());

	// No file selected — show placeholder.
	if (selectedPath === null) {
		return (
			<div className="flex flex-col flex-1 min-w-0 items-center justify-center">
				<span className="text-[13px] text-text-tertiary">Select a file to view conflict details</span>
			</div>
		);
	}

	// File is resolved.
	if (resolvedFiles.has(selectedPath)) {
		return (
			<div className="flex flex-col flex-1 min-w-0 items-center justify-center gap-2">
				<CheckCircle size={28} className="text-status-green" />
				<span className="text-[13px] text-text-primary font-medium">File resolved</span>
				<span className="text-[12px] text-text-secondary">{getBasename(selectedPath)}</span>
			</div>
		);
	}

	// File is unresolved — look it up in loaded conflict files.
	const selectedFile = conflictFiles.find((f) => f.path === selectedPath);

	// Still loading / not yet fetched.
	if (!selectedFile) {
		return (
			<div className="flex flex-col flex-1 min-w-0 items-center justify-center gap-2">
				{isLoading ? (
					<>
						<Spinner size={20} />
						<span className="text-[13px] text-text-tertiary">Loading conflict data...</span>
					</>
				) : (
					<span className="text-[13px] text-text-tertiary">Conflict data unavailable for this file</span>
				)}
			</div>
		);
	}

	// Build the single-file diff payload for the DiffViewerPanel.
	const conflictFileChanges: RuntimeWorkspaceFileChange[] = [
		{
			path: selectedFile.path,
			status: "conflicted",
			oldText: selectedFile.oursContent,
			newText: selectedFile.theirsContent,
			additions: 0,
			deletions: 0,
		},
	];

	const handleResolveManually = (): void => {
		const filename = getBasename(selectedPath);
		toast.info(
			`Edit ${filename} in the terminal and run \`git add ${selectedPath}\` when done. The conflict panel will update automatically.`,
		);
	};

	return (
		<div className="flex flex-col flex-1 min-w-0 min-h-0">
			{/* Ours-vs-theirs diff */}
			<div className="flex-1 min-h-0 overflow-hidden">
				<DiffViewerPanel
					workspaceFiles={conflictFileChanges}
					selectedPath={selectedPath}
					onSelectedPathChange={() => {}}
					comments={diffComments}
					onCommentsChange={setDiffComments}
				/>
			</div>

			{/* Resolution action buttons */}
			<div className="flex items-center gap-2 px-3 py-2 border-t border-border bg-surface-1 shrink-0">
				<Button
					variant="default"
					size="sm"
					icon={<UserCheck size={14} />}
					onClick={() => resolveFile(selectedPath, "ours")}
				>
					Accept Ours
				</Button>
				<Button
					variant="default"
					size="sm"
					icon={<Users size={14} />}
					onClick={() => resolveFile(selectedPath, "theirs")}
				>
					Accept Theirs
				</Button>
				<Button variant="ghost" size="sm" icon={<Pencil size={14} />} onClick={handleResolveManually}>
					Resolve Manually
				</Button>
			</div>
		</div>
	);
}

export function ConflictResolutionPanel({
	conflictState,
	conflictFiles,
	resolvedFiles,
	selectedPath,
	setSelectedPath,
	resolveFile,
	continueResolution,
	abortResolution,
	isLoading,
}: ConflictResolutionPanelProps): React.ReactElement {
	const isMerge = conflictState.operation === "merge";
	const operationLabel = isMerge ? "Merge" : "Rebase";
	const OperationIcon = isMerge ? GitMerge : GitPullRequest;

	const unresolvedCount = conflictState.conflictedFiles.length;
	const totalFiles = unresolvedCount + resolvedFiles.size;
	const allResolved = unresolvedCount === 0;

	// Build a combined file list: unresolved first, then resolved.
	const allFiles = useMemo(() => {
		const unresolved = conflictState.conflictedFiles.map((path) => ({
			path,
			resolved: false,
		}));
		const resolved = Array.from(resolvedFiles)
			.filter((path) => !conflictState.conflictedFiles.includes(path))
			.map((path) => ({
				path,
				resolved: true,
			}));
		return [...unresolved, ...resolved];
	}, [conflictState.conflictedFiles, resolvedFiles]);

	// Banner text
	const bannerText = useMemo(() => {
		const conflictSuffix = `${unresolvedCount} ${unresolvedCount === 1 ? "conflict" : "conflicts"} remaining`;
		if (isMerge) {
			return `Merge in progress \u2014 ${conflictSuffix}`;
		}
		const { currentStep, totalSteps } = conflictState;
		if (currentStep != null && totalSteps != null) {
			return `Rebase in progress \u2014 commit ${currentStep} of ${totalSteps} \u2014 ${conflictSuffix}`;
		}
		return `Rebase in progress \u2014 ${conflictSuffix}`;
	}, [isMerge, unresolvedCount, conflictState]);

	return (
		<div className="flex flex-col flex-1 min-h-0 min-w-0 bg-surface-0">
			{/* Banner */}
			<div className="flex items-center gap-2 px-3 py-2 bg-status-orange/10 border-l-2 border-status-orange shrink-0">
				<OperationIcon size={16} className="text-status-orange shrink-0" />
				<span className="text-[13px] text-text-primary font-medium">{bannerText}</span>
			</div>

			{/* Content area */}
			<div className="flex flex-1 min-h-0">
				{/* Left pane — file list */}
				<div className="flex flex-col w-[250px] shrink-0 border-r border-border overflow-y-auto overscroll-contain">
					{allFiles.map((file) => {
						const isSelected = file.path === selectedPath;
						return (
							<button
								key={file.path}
								type="button"
								className={cn(
									"flex items-center gap-2 w-full px-3 py-1.5 text-left text-[12px] cursor-pointer border-0",
									"hover:bg-surface-3",
									isSelected && "bg-surface-3",
									!isSelected && "bg-transparent",
								)}
								onClick={() => setSelectedPath(file.path)}
							>
								{file.resolved ? (
									<Check size={14} className="text-status-green shrink-0" />
								) : (
									<AlertTriangle size={14} className="text-status-orange shrink-0" />
								)}
								<span className="truncate text-text-primary" title={file.path}>
									{getBasename(file.path)}
								</span>
							</button>
						);
					})}
				</div>

				{/* Right pane — detail view */}
				<ConflictDetailPane
					selectedPath={selectedPath}
					conflictFiles={conflictFiles}
					resolvedFiles={resolvedFiles}
					resolveFile={resolveFile}
					isLoading={isLoading}
				/>
			</div>

			{/* Action bar */}
			<div className="flex items-center justify-between px-3 py-2 border-t border-border bg-surface-1 shrink-0">
				<span className="text-[12px] text-text-secondary">
					{resolvedFiles.size} of {totalFiles} files resolved
				</span>
				<div className="flex items-center gap-2">
					<Button variant="danger" size="sm" icon={<XCircle size={14} />} onClick={() => abortResolution()}>
						Abort {operationLabel}
					</Button>
					<Button
						variant="primary"
						size="sm"
						icon={<CheckCircle size={14} />}
						disabled={!allResolved}
						onClick={() => continueResolution()}
					>
						Complete {operationLabel}
					</Button>
				</div>
			</div>
		</div>
	);
}
