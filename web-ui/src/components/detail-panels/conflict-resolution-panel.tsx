import {
	AlertTriangle,
	Check,
	CheckCircle,
	Clipboard,
	FileCheck,
	GitMerge,
	GitPullRequest,
	Info,
	UserCheck,
	Users,
	XCircle,
} from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";

import { buildUnifiedDiffRows, ReadOnlyUnifiedDiff } from "@/components/shared/diff-renderer";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import type { RuntimeAutoMergedFile, RuntimeConflictFile, RuntimeConflictState } from "@/runtime/types";

export interface ConflictResolutionPanelProps {
	conflictState: RuntimeConflictState;
	conflictFiles: RuntimeConflictFile[];
	resolvedFiles: ReadonlySet<string>;
	autoMergedFiles: RuntimeAutoMergedFile[];
	reviewedAutoMergedFiles: ReadonlySet<string>;
	acceptAutoMergedFile: (path: string) => void;
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
	autoMergedFiles,
	reviewedAutoMergedFiles,
	acceptAutoMergedFile,
	resolveFile,
	isLoading,
}: {
	selectedPath: string | null;
	conflictFiles: RuntimeConflictFile[];
	resolvedFiles: ReadonlySet<string>;
	autoMergedFiles: RuntimeAutoMergedFile[];
	reviewedAutoMergedFiles: ReadonlySet<string>;
	acceptAutoMergedFile: (path: string) => void;
	resolveFile: (path: string, resolution: "ours" | "theirs") => Promise<{ ok: boolean; error?: string }>;
	isLoading: boolean;
}): React.ReactElement {
	// No file selected — show placeholder.
	if (selectedPath === null) {
		return (
			<div className="flex flex-col flex-1 min-w-0 items-center justify-center">
				<span className="text-[13px] text-text-tertiary">Select a file to view conflict details</span>
			</div>
		);
	}

	// File is resolved (conflict resolved).
	if (resolvedFiles.has(selectedPath)) {
		return (
			<div className="flex flex-col flex-1 min-w-0 items-center justify-center gap-2">
				<CheckCircle size={28} className="text-status-green" />
				<span className="text-[13px] text-text-primary font-medium">File resolved</span>
				<span className="text-[12px] text-text-secondary">{getBasename(selectedPath)}</span>
			</div>
		);
	}

	// Check if this is an auto-merged file.
	const autoMergedFile = autoMergedFiles.find((f) => f.path === selectedPath);
	if (autoMergedFile) {
		const isReviewed = reviewedAutoMergedFiles.has(selectedPath);
		const rows = buildUnifiedDiffRows(autoMergedFile.oldContent, autoMergedFile.newContent);
		return (
			<div className="flex flex-col flex-1 min-w-0 min-h-0">
				{/* Header */}
				<div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface-1 shrink-0">
					<span className="text-[12px] text-text-secondary font-medium">Auto-merged changes</span>
					<span className="text-[11px] text-text-tertiary">{selectedPath}</span>
				</div>
				{/* Diff */}
				<div className="flex-1 min-h-0 overflow-auto">
					{rows.length > 0 ? (
						<ReadOnlyUnifiedDiff rows={rows} path={selectedPath} />
					) : (
						<div className="flex items-center justify-center h-full">
							<span className="text-[13px] text-text-tertiary">No changes in this file</span>
						</div>
					)}
				</div>
				{/* Accept button */}
				<div className="flex items-center gap-2 px-3 py-2 border-t border-border bg-surface-1 shrink-0">
					{isReviewed ? (
						<span className="flex items-center gap-1.5 text-[12px] text-status-green">
							<CheckCircle size={14} /> Accepted
						</span>
					) : (
						<Button
							variant="primary"
							size="sm"
							icon={<Check size={14} />}
							onClick={() => acceptAutoMergedFile(selectedPath)}
						>
							Accept Auto-merge
						</Button>
					)}
				</div>
			</div>
		);
	}

	// File is unresolved conflict — look it up in loaded conflict files.
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

	// Build diff rows directly using the ours/theirs content.
	const hasContent = selectedFile.oursContent.length > 0 || selectedFile.theirsContent.length > 0;
	const rows = hasContent ? buildUnifiedDiffRows(selectedFile.oursContent, selectedFile.theirsContent) : [];

	const handleCopyPath = (): void => {
		void navigator.clipboard.writeText(selectedPath);
		toast.success("Path copied to clipboard");
	};

	return (
		<div className="flex flex-col flex-1 min-w-0 min-h-0">
			{/* Column headers */}
			<div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface-1 shrink-0">
				<span className="text-[12px] text-status-red font-medium">Ours (current branch)</span>
				<span className="text-[11px] text-text-tertiary">→</span>
				<span className="text-[12px] text-status-green font-medium">Theirs (incoming)</span>
			</div>

			{/* Diff or error state */}
			<div className="flex-1 min-h-0 overflow-auto">
				{hasContent ? (
					<ReadOnlyUnifiedDiff rows={rows} path={selectedPath} />
				) : (
					<div className="flex flex-col items-center justify-center h-full gap-2 px-4">
						<AlertTriangle size={24} className="text-status-orange" />
						<span className="text-[13px] text-text-primary font-medium">Could not load conflict content</span>
						<span className="text-[12px] text-text-secondary text-center">
							The file may be binary or the conflict data is unavailable. Resolve it manually using your editor.
						</span>
					</div>
				)}
			</div>

			{/* Manual resolution info bar */}
			<div className="flex items-center gap-2 px-3 py-1.5 border-t border-border bg-surface-0 shrink-0 text-[11px] text-text-secondary">
				<Info size={13} className="shrink-0 text-text-tertiary" />
				<span>
					To resolve manually, edit in your editor then run{" "}
					<code className="text-text-primary bg-surface-2 px-1 py-0.5 rounded text-[10px]">
						git add {selectedPath}
					</code>
				</span>
				<button
					type="button"
					onClick={handleCopyPath}
					className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface-2 border-0 cursor-pointer text-text-secondary hover:text-text-primary text-[10px]"
				>
					<Clipboard size={11} /> Copy path
				</button>
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
			</div>
		</div>
	);
}

export function ConflictResolutionPanel({
	conflictState,
	conflictFiles,
	resolvedFiles,
	autoMergedFiles,
	reviewedAutoMergedFiles,
	acceptAutoMergedFile,
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
	const totalConflictFiles = unresolvedCount + resolvedFiles.size;
	const allConflictsResolved = unresolvedCount === 0;
	const autoMergedCount = conflictState.autoMergedFiles.length;
	const allAutoMergedReviewed =
		autoMergedCount === 0 || conflictState.autoMergedFiles.every((f) => reviewedAutoMergedFiles.has(f));
	const allReviewed = allConflictsResolved && allAutoMergedReviewed;

	// Build combined file list: unresolved conflicts first, resolved conflicts, then auto-merged.
	const allFiles = useMemo(() => {
		const unresolved = conflictState.conflictedFiles.map((path) => ({
			path,
			resolved: false,
			section: "conflict" as const,
		}));
		const resolved = Array.from(resolvedFiles)
			.filter((path) => !conflictState.conflictedFiles.includes(path))
			.map((path) => ({
				path,
				resolved: true,
				section: "conflict" as const,
			}));
		const autoMerged = conflictState.autoMergedFiles.map((path) => ({
			path,
			resolved: reviewedAutoMergedFiles.has(path),
			section: "auto_merged" as const,
		}));
		return [...unresolved, ...resolved, ...autoMerged];
	}, [conflictState.conflictedFiles, conflictState.autoMergedFiles, resolvedFiles, reviewedAutoMergedFiles]);

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

	// Progress text
	const progressText = useMemo(() => {
		const conflictPart = `${resolvedFiles.size}/${totalConflictFiles} conflicts`;
		if (autoMergedCount === 0) return `${conflictPart} resolved`;
		const autoMergedPart = `${reviewedAutoMergedFiles.size}/${autoMergedCount} auto-merged`;
		return `${conflictPart} resolved, ${autoMergedPart} reviewed`;
	}, [resolvedFiles.size, totalConflictFiles, autoMergedCount, reviewedAutoMergedFiles.size]);

	// Track where the auto-merged section starts for rendering a header.
	const autoMergedStartIndex = allFiles.findIndex((f) => f.section === "auto_merged");

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
					{allFiles.map((file, index) => {
						const isSelected = file.path === selectedPath;
						const showAutoMergedHeader = index === autoMergedStartIndex && autoMergedStartIndex > 0;
						return (
							<div key={file.path}>
								{showAutoMergedHeader && (
									<div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary border-t border-border mt-1">
										Auto-merged
									</div>
								)}
								<button
									type="button"
									className={cn(
										"flex items-center gap-2 w-full px-3 py-1.5 text-left text-[12px] cursor-pointer border-0",
										"hover:bg-surface-3",
										isSelected && "bg-surface-3",
										!isSelected && "bg-transparent",
									)}
									onClick={() => setSelectedPath(file.path)}
								>
									{file.section === "auto_merged" ? (
										file.resolved ? (
											<Check size={14} className="text-status-green shrink-0" />
										) : (
											<FileCheck size={14} className="text-status-blue shrink-0" />
										)
									) : file.resolved ? (
										<Check size={14} className="text-status-green shrink-0" />
									) : (
										<AlertTriangle size={14} className="text-status-orange shrink-0" />
									)}
									<span className="truncate text-text-primary" title={file.path}>
										{getBasename(file.path)}
									</span>
								</button>
							</div>
						);
					})}
				</div>

				{/* Right pane — detail view */}
				<ConflictDetailPane
					selectedPath={selectedPath}
					conflictFiles={conflictFiles}
					resolvedFiles={resolvedFiles}
					autoMergedFiles={autoMergedFiles}
					reviewedAutoMergedFiles={reviewedAutoMergedFiles}
					acceptAutoMergedFile={acceptAutoMergedFile}
					resolveFile={resolveFile}
					isLoading={isLoading}
				/>
			</div>

			{/* Action bar */}
			<div className="flex items-center justify-between px-3 py-2 border-t border-border bg-surface-1 shrink-0">
				<span className="text-[12px] text-text-secondary">{progressText}</span>
				<div className="flex items-center gap-2">
					<Button variant="danger" size="sm" icon={<XCircle size={14} />} onClick={() => abortResolution()}>
						Abort {operationLabel}
					</Button>
					<Button
						variant="primary"
						size="sm"
						icon={<CheckCircle size={14} />}
						disabled={!allReviewed}
						onClick={() => continueResolution()}
					>
						Complete {operationLabel}
					</Button>
				</div>
			</div>
		</div>
	);
}
