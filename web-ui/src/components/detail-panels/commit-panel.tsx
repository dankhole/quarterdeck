import * as Checkbox from "@radix-ui/react-checkbox";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
	Check,
	ChevronDown,
	ChevronRight,
	ClipboardCopy,
	FileSearch,
	FileText,
	GitCompare,
	MessageSquare,
	Minus,
	Sparkles,
	Undo2,
	X,
} from "lucide-react";
import { useState } from "react";
import { CONTEXT_MENU_ITEM_CLASS, copyToClipboard } from "@/components/detail-panels/context-menu-utils";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { useCommitPanel } from "@/hooks/use-commit-panel";
import type { RuntimeWorkspaceFileChange } from "@/runtime/types";
import { useHomeStashCount } from "@/stores/workspace-metadata-store";
import { StashListSection } from "./stash-list-section";

export interface CommitPanelProps {
	workspaceId: string;
	taskId: string | null;
	baseRef: string | null;
	navigateToFile?: (nav: { targetView: "git" | "files"; filePath: string }) => void;
}

const STATUS_BADGE: Record<string, { letter: string; className: string }> = {
	modified: { letter: "M", className: "text-status-blue" },
	added: { letter: "A", className: "text-status-green" },
	deleted: { letter: "D", className: "text-status-red" },
	renamed: { letter: "R", className: "text-status-orange" },
	copied: { letter: "C", className: "text-status-blue" },
	untracked: { letter: "U", className: "text-text-secondary" },
	conflicted: { letter: "!", className: "text-status-orange" },
	unknown: { letter: "?", className: "text-text-tertiary" },
};

function CommitFileRow({
	file,
	checked,
	onToggle,
	onRollback,
	onNavigateToFile,
}: {
	file: RuntimeWorkspaceFileChange;
	checked: boolean;
	onToggle: () => void;
	onRollback: () => void;
	onNavigateToFile?: (nav: { targetView: "git" | "files"; filePath: string }) => void;
}): React.ReactElement {
	const badge = STATUS_BADGE[file.status] ?? { letter: "?", className: "text-text-tertiary" };
	const fileName = file.path.split("/").pop() ?? file.path;
	const canRollback = file.status !== "renamed" && file.status !== "copied";

	return (
		<ContextMenu.Root>
			<ContextMenu.Trigger asChild>
				<div className="flex items-center gap-1.5 px-2 py-1 hover:bg-surface-3 rounded-sm min-w-0 group cursor-default">
					<Checkbox.Root
						checked={checked}
						onCheckedChange={onToggle}
						className="flex items-center justify-center w-4 h-4 shrink-0 rounded-sm border border-border bg-surface-2 data-[state=checked]:bg-accent data-[state=checked]:border-accent cursor-pointer"
					>
						<Checkbox.Indicator>
							<Check size={12} className="text-white" />
						</Checkbox.Indicator>
					</Checkbox.Root>
					<FileText size={14} className="shrink-0 text-text-tertiary" />
					<span className="truncate flex-1 text-[13px] text-text-primary" title={file.path}>
						{fileName}
						{file.path.includes("/") ? (
							<span className="text-text-tertiary ml-1">{file.path.slice(0, file.path.lastIndexOf("/"))}</span>
						) : null}
					</span>
					<span className={cn("shrink-0 text-[11px] font-mono font-medium w-4 text-center", badge.className)}>
						{badge.letter}
					</span>
					{file.additions > 0 || file.deletions > 0 ? (
						<span className="shrink-0 font-mono text-[10px] flex gap-0.5">
							{file.additions > 0 ? <span className="text-status-green">+{file.additions}</span> : null}
							{file.deletions > 0 ? <span className="text-status-red">-{file.deletions}</span> : null}
						</span>
					) : null}
				</div>
			</ContextMenu.Trigger>
			<ContextMenu.Portal>
				<ContextMenu.Content className="z-50 min-w-[160px] rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg">
					<ContextMenu.Item
						className={cn(CONTEXT_MENU_ITEM_CLASS, canRollback ? "text-status-red" : "opacity-50")}
						disabled={!canRollback}
						onSelect={canRollback ? onRollback : undefined}
					>
						<Undo2 size={14} className={canRollback ? "text-status-red" : "text-text-tertiary"} />
						{canRollback ? "Rollback" : "Cannot rollback renamed/copied"}
					</ContextMenu.Item>
					{onNavigateToFile ? (
						<>
							<ContextMenu.Item
								className={CONTEXT_MENU_ITEM_CLASS}
								onSelect={() => onNavigateToFile({ targetView: "git", filePath: file.path })}
							>
								<GitCompare size={14} className="text-text-secondary" />
								Open in Diff Viewer
							</ContextMenu.Item>
							<ContextMenu.Item
								className={CONTEXT_MENU_ITEM_CLASS}
								onSelect={() => onNavigateToFile({ targetView: "files", filePath: file.path })}
							>
								<FileSearch size={14} className="text-text-secondary" />
								Open in File Browser
							</ContextMenu.Item>
						</>
					) : null}
					<ContextMenu.Separator className="h-px bg-border my-1" />
					<ContextMenu.Item className={CONTEXT_MENU_ITEM_CLASS} onSelect={() => copyToClipboard(fileName, "Name")}>
						<ClipboardCopy size={14} className="text-text-secondary" />
						Copy name
					</ContextMenu.Item>
					<ContextMenu.Item
						className={CONTEXT_MENU_ITEM_CLASS}
						onSelect={() => copyToClipboard(file.path, "Path")}
					>
						<ClipboardCopy size={14} className="text-text-secondary" />
						Copy path
					</ContextMenu.Item>
				</ContextMenu.Content>
			</ContextMenu.Portal>
		</ContextMenu.Root>
	);
}

export function CommitPanel({ workspaceId, taskId, baseRef, navigateToFile }: CommitPanelProps): React.ReactElement {
	const {
		files,
		selectedPaths,
		isAllSelected,
		isIndeterminate,
		toggleFile,
		toggleAll,
		message,
		setMessage,
		canCommit,
		canPush,
		isLoading,
		isCommitting,
		isPushing,
		isDiscarding,
		isStashing,
		isGeneratingMessage,
		generateMessage,
		stashMessage,
		setStashMessage,
		stashChanges,
		lastError,
		clearError,
		discardAll,
		commitFiles,
		commitAndPush,
		rollbackFile,
	} = useCommitPanel(taskId, workspaceId, baseRef);

	const stashCount = useHomeStashCount();
	const [discardDialogOpen, setDiscardDialogOpen] = useState(false);
	const [errorExpanded, setErrorExpanded] = useState(false);
	const [stashMessageVisible, setStashMessageVisible] = useState(false);

	const fileCount = files?.length ?? 0;
	const hasFiles = fileCount > 0;

	return (
		<div className="flex flex-col h-full bg-surface-0">
			{/* Header */}
			<div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
				<span className="text-[13px] font-medium text-text-secondary">Changes</span>
				{hasFiles ? (
					<span className="text-[11px] text-text-tertiary bg-surface-2 rounded-full px-1.5 py-0.5">
						{fileCount}
					</span>
				) : null}
			</div>

			{/* Select all row */}
			{hasFiles ? (
				<div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border shrink-0">
					<Checkbox.Root
						checked={isAllSelected ? true : isIndeterminate ? "indeterminate" : false}
						onCheckedChange={toggleAll}
						className="flex items-center justify-center w-4 h-4 shrink-0 rounded-sm border border-border bg-surface-2 data-[state=checked]:bg-accent data-[state=checked]:border-accent data-[state=indeterminate]:bg-accent data-[state=indeterminate]:border-accent cursor-pointer"
					>
						<Checkbox.Indicator>
							{isIndeterminate ? (
								<Minus size={12} className="text-white" />
							) : (
								<Check size={12} className="text-white" />
							)}
						</Checkbox.Indicator>
					</Checkbox.Root>
					<span className="text-[12px] text-text-secondary">
						Select all ({fileCount} {fileCount === 1 ? "file" : "files"})
					</span>
				</div>
			) : null}

			{/* File list */}
			<div className="flex-1 overflow-y-auto min-h-0">
				{isLoading && !files ? (
					<div className="flex items-center justify-center h-full">
						<Spinner size={20} />
					</div>
				) : !hasFiles ? (
					<div className="flex items-center justify-center h-full text-text-tertiary text-[13px]">
						No uncommitted changes
					</div>
				) : (
					<div className="py-1">
						{files?.map((file) => (
							<CommitFileRow
								key={file.path}
								file={file}
								checked={selectedPaths.includes(file.path)}
								onToggle={() => toggleFile(file.path)}
								onRollback={() => void rollbackFile(file.path, file.status)}
								onNavigateToFile={navigateToFile}
							/>
						))}
					</div>
				)}
			</div>

			{/* Bottom section — stash/discard, then commit message + commit buttons */}
			<div className="shrink-0 border-t border-border p-3 flex flex-col gap-2">
				{lastError ? (
					<div className="rounded-md border border-status-red/40 bg-status-red/10 text-[12px]">
						<div className="flex items-center gap-1 px-2 py-1.5">
							<button
								type="button"
								className="flex items-center gap-1 flex-1 min-w-0 text-left text-status-red cursor-pointer"
								onClick={() => setErrorExpanded((v) => !v)}
							>
								{errorExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
								<span className="font-medium">Commit failed</span>
							</button>
							<button
								type="button"
								className="p-0.5 rounded text-text-tertiary hover:text-text-primary cursor-pointer"
								onClick={clearError}
							>
								<X size={12} />
							</button>
						</div>
						{errorExpanded ? (
							<pre className="px-2 pb-2 text-text-secondary whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto font-mono text-[11px] leading-relaxed">
								{lastError}
							</pre>
						) : null}
					</div>
				) : null}
				{/* Stash & discard row — above commit to separate "save work" from "commit" */}
				{hasFiles ? (
					<>
						<div className="flex gap-2">
							<div className="flex items-center gap-0.5">
								<Button
									variant="default"
									size="sm"
									disabled={!hasFiles || isStashing}
									onClick={() => void stashChanges()}
								>
									{isStashing ? <Spinner size={14} /> : "Stash"}
								</Button>
								{!stashMessageVisible ? (
									<button
										type="button"
										className="p-1 rounded text-text-tertiary hover:text-text-secondary hover:bg-surface-3 cursor-pointer"
										title="Add stash message"
										onClick={() => setStashMessageVisible(true)}
									>
										<MessageSquare size={14} />
									</button>
								) : null}
							</div>
							<Button
								variant="danger"
								size="sm"
								disabled={isDiscarding || !hasFiles}
								onClick={() => setDiscardDialogOpen(true)}
							>
								{isDiscarding ? <Spinner size={14} /> : "Discard All"}
							</Button>
						</div>
						{/* Stash message — collapsible input */}
						{stashMessageVisible ? (
							<div className="flex items-center gap-1.5">
								<input
									type="text"
									value={stashMessage}
									onChange={(e) => setStashMessage(e.target.value)}
									placeholder="Stash message (optional)"
									className="flex-1 bg-surface-2 border border-border rounded-md px-2 py-1 text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-focus"
								/>
								<button
									type="button"
									className="p-1 rounded text-text-tertiary hover:text-text-primary cursor-pointer"
									onClick={() => {
										setStashMessageVisible(false);
										setStashMessage("");
									}}
								>
									<X size={14} />
								</button>
							</div>
						) : null}
					</>
				) : null}
				{/* Commit message + generate button */}
				<div className="relative">
					<textarea
						value={message}
						onChange={(e) => setMessage(e.target.value)}
						placeholder="Commit message"
						rows={3}
						className="w-full bg-surface-2 border border-border rounded-md p-2 pr-8 text-[13px] text-text-primary placeholder:text-text-tertiary resize-y min-h-[4.5rem] focus:outline-none focus:border-border-focus"
					/>
					<Tooltip content="Generate commit message from diff">
						<button
							type="button"
							className={cn(
								"absolute top-2 right-2 p-1 rounded cursor-pointer",
								isGeneratingMessage
									? "text-accent"
									: "text-text-tertiary hover:text-text-secondary hover:bg-surface-3",
							)}
							disabled={isGeneratingMessage || selectedPaths.length === 0}
							onClick={() => void generateMessage()}
						>
							{isGeneratingMessage ? <Spinner size={14} /> : <Sparkles size={14} />}
						</button>
					</Tooltip>
				</div>
				{/* Commit buttons */}
				<div className="flex gap-2">
					<Button variant="primary" size="sm" disabled={!canCommit} onClick={() => void commitFiles()}>
						{isCommitting && !isPushing ? <Spinner size={14} /> : "Commit"}
					</Button>
					<Tooltip
						content={
							canCommit && !canPush ? "Push unavailable on detached HEAD" : "Commit selected files and push"
						}
					>
						<span className="inline-flex">
							<Button variant="default" size="sm" disabled={!canPush} onClick={() => void commitAndPush()}>
								{isPushing ? <Spinner size={14} /> : "Commit & Push"}
							</Button>
						</span>
					</Tooltip>
				</div>
			</div>

			{/* Stash list */}
			<StashListSection taskId={taskId ?? undefined} workspaceId={workspaceId} stashCount={stashCount} />

			{/* Discard All confirmation */}
			<AlertDialog open={discardDialogOpen} onOpenChange={(open) => !open && setDiscardDialogOpen(false)}>
				<AlertDialogHeader>
					<AlertDialogTitle>Discard all changes?</AlertDialogTitle>
				</AlertDialogHeader>
				<AlertDialogBody>
					<AlertDialogDescription>
						This will revert all {fileCount} {fileCount === 1 ? "file" : "files"} to HEAD and remove untracked
						files.
					</AlertDialogDescription>
					<p className="text-text-primary">This action cannot be undone.</p>
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel asChild>
						<Button variant="default" onClick={() => setDiscardDialogOpen(false)}>
							Cancel
						</Button>
					</AlertDialogCancel>
					<AlertDialogAction asChild>
						<Button
							variant="danger"
							onClick={() => {
								setDiscardDialogOpen(false);
								void discardAll();
							}}
						>
							Discard All
						</Button>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialog>
		</div>
	);
}
