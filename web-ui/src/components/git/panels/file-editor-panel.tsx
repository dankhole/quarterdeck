import {
	BookOpen,
	Check,
	Clipboard,
	Code,
	Copy,
	FileText,
	PanelTopClose,
	RotateCcw,
	Save,
	SaveAll,
	Search,
	WrapText,
	X,
} from "lucide-react";
import Prism from "prismjs";
import { type FocusEvent, type HTMLAttributes, type ReactElement, type ReactNode, useCallback, useRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { SourceEditor, type SourceEditorHandle } from "@/components/editor/source-editor";
import { copyToClipboard } from "@/components/git/panels/context-menu-utils";
import { resolvePrismGrammar, resolvePrismLanguageByAlias } from "@/components/shared/syntax-highlighting";
import { cn } from "@/components/ui/cn";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { AlertDialogDescription } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { FileEditorDiscardPrompt } from "@/hooks/git";
import {
	type FileEditorAutosaveMode,
	type FileEditorTab,
	isFileEditorTabDirty,
} from "@/hooks/git/file-editor-workspace";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { useBooleanLocalStorageValue } from "@/utils/react-use";

const REMARK_PLUGINS = [remarkGfm];

function isMarkdownFile(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	return lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".mdx");
}

function MarkdownCodeBlock({
	className,
	children,
}: HTMLAttributes<HTMLElement> & { children?: ReactNode }): ReactElement {
	const match = /language-(\w+)/.exec(className ?? "");
	if (!match) {
		return <code className={className}>{children}</code>;
	}
	const language = resolvePrismLanguageByAlias(match[1]!);
	const grammar = resolvePrismGrammar(language);
	if (!grammar || !language) {
		return <code className={className}>{children}</code>;
	}
	const code = String(children ?? "").replace(/\n$/, "");
	const html = Prism.highlight(code, grammar, language);
	return <code className={cn(className, "kb-syntax")} dangerouslySetInnerHTML={{ __html: html }} />;
}

const MARKDOWN_COMPONENTS = { code: MarkdownCodeBlock };

interface FileEditorPanelProps {
	tabs: readonly FileEditorTab[];
	activeTab: FileEditorTab | null;
	activePath: string | null;
	isLoading: boolean;
	isError: boolean;
	isReadOnly: boolean;
	canEditActiveTab: boolean;
	isActiveTabDirty: boolean;
	hasDirtyTabs: boolean;
	discardPrompt: FileEditorDiscardPrompt | null;
	autosaveMode: FileEditorAutosaveMode;
	scrollToLine?: number | null;
	onScrollToLineConsumed?: () => void;
	onSelectTab: (path: string) => void;
	onCloseTab: (path: string) => void;
	onChangeActiveContent: (value: string) => void;
	onSaveActiveTab: () => Promise<void>;
	onSaveAllTabs: () => Promise<void>;
	onCloseAllTabs: () => void;
	onAutosaveFocusChange: () => void;
	onReloadActiveTab: () => Promise<void>;
	onCancelDiscardPrompt: () => void;
	onConfirmDiscardPrompt: () => Promise<void>;
}

export function FileEditorPanel({
	tabs,
	activeTab,
	activePath,
	isLoading,
	isError,
	isReadOnly,
	canEditActiveTab,
	isActiveTabDirty,
	hasDirtyTabs,
	discardPrompt,
	autosaveMode,
	scrollToLine,
	onScrollToLineConsumed,
	onSelectTab,
	onCloseTab,
	onChangeActiveContent,
	onSaveActiveTab,
	onSaveAllTabs,
	onCloseAllTabs,
	onAutosaveFocusChange,
	onReloadActiveTab,
	onCancelDiscardPrompt,
	onConfirmDiscardPrompt,
}: FileEditorPanelProps): ReactElement {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const sourceEditorRef = useRef<SourceEditorHandle | null>(null);
	const [wordWrap, setWordWrap] = useBooleanLocalStorageValue(LocalStorageKey.FileBrowserWordWrap, true);
	const toggleWordWrap = useCallback(() => setWordWrap((prev) => !prev), [setWordWrap]);
	const [markdownPreview, setMarkdownPreview] = useBooleanLocalStorageValue(
		LocalStorageKey.FileBrowserMarkdownPreview,
		true,
	);
	const toggleMarkdownPreview = useCallback(() => setMarkdownPreview((prev) => !prev), [setMarkdownPreview]);

	const handleCopyPath = useCallback(() => {
		if (!activeTab) return;
		copyToClipboard(activeTab.path, "Path");
	}, [activeTab]);

	const handleCopyContent = useCallback(() => {
		if (!activeTab || activeTab.binary) return;
		copyToClipboard(activeTab.value, "File contents");
	}, [activeTab]);

	const handleOpenFindReplace = useCallback(() => {
		sourceEditorRef.current?.openSearchPanel();
	}, []);

	const handleBlurCapture = useCallback(
		(event: FocusEvent<HTMLDivElement>) => {
			if (autosaveMode !== "focus" || discardPrompt !== null) {
				return;
			}
			const nextTarget = event.relatedTarget;
			if (nextTarget instanceof Node && rootRef.current?.contains(nextTarget)) {
				return;
			}
			onAutosaveFocusChange();
		},
		[autosaveMode, discardPrompt, onAutosaveFocusChange],
	);

	if (!activePath && tabs.length === 0) {
		return (
			<div className="flex flex-1 items-center justify-center text-text-tertiary bg-surface-1">
				<div className="flex flex-col items-center gap-3">
					<FileText size={40} />
					<span className="text-sm">Select a file to view</span>
				</div>
			</div>
		);
	}

	if (!activeTab && isLoading) {
		return (
			<div className="flex flex-1 items-center justify-center bg-surface-1">
				<Spinner size={24} />
			</div>
		);
	}

	if (!activeTab && isError) {
		return (
			<div className="flex flex-1 items-center justify-center text-text-tertiary bg-surface-1">
				<div className="flex flex-col items-center gap-3">
					<FileText size={40} />
					<span className="text-sm">Failed to load file</span>
				</div>
			</div>
		);
	}

	const isMarkdown = activeTab ? isMarkdownFile(activeTab.path) : false;
	const showRendered = Boolean(activeTab && isMarkdown && markdownPreview);
	const saveDisabled = !activeTab || !canEditActiveTab || !isActiveTabDirty || activeTab.isSaving;
	const saveAllDisabled = !hasDirtyTabs || tabs.some((tab) => tab.isSaving);
	const hasSavingTabs = tabs.some((tab) => tab.isSaving);
	const closeAllDisabled = tabs.length === 0 || hasSavingTabs;
	const reloadDisabled = !activeTab || activeTab.isSaving;
	const findReplaceDisabled = !activeTab || activeTab.binary || showRendered;
	const showReadOnlyBadge = Boolean(isReadOnly || activeTab?.editBlockedReason);
	const discardTitle =
		discardPrompt?.action === "reload"
			? "Reload file?"
			: discardPrompt?.action === "close_all"
				? "Close all files?"
				: "Close file?";
	const discardConfirmLabel = discardPrompt?.action === "reload" ? "Reload" : "Close";

	return (
		<div
			ref={rootRef}
			onBlurCapture={handleBlurCapture}
			className="flex flex-1 flex-col min-w-0 min-h-0 bg-surface-1"
		>
			<ConfirmationDialog
				open={discardPrompt !== null}
				title={discardTitle}
				confirmLabel={discardConfirmLabel}
				onCancel={onCancelDiscardPrompt}
				onConfirm={() => void onConfirmDiscardPrompt()}
			>
				<AlertDialogDescription>
					{discardPrompt?.action === "close_all" ? (
						`${discardPrompt.dirtyCount} unsaved file${discardPrompt.dirtyCount === 1 ? "" : "s"} will be discarded.`
					) : discardPrompt?.path ? (
						<>
							Unsaved changes in <span className="font-mono text-text-primary">{discardPrompt.path}</span> will
							be discarded.
						</>
					) : (
						"Unsaved changes will be discarded."
					)}
				</AlertDialogDescription>
			</ConfirmationDialog>
			{tabs.length > 0 ? (
				<div className="flex items-center min-h-8 border-b border-border bg-surface-0 overflow-x-auto">
					{tabs.map((tab) => {
						const selected = tab.path === activePath;
						const dirty = isFileEditorTabDirty(tab);
						return (
							<div
								key={tab.path}
								className={cn(
									"group flex items-center max-w-56 min-w-0 h-8 border-r border-border text-xs",
									selected
										? "bg-surface-1 text-text-primary"
										: "bg-surface-0 text-text-secondary hover:bg-surface-2 hover:text-text-primary",
								)}
								onMouseDown={(event) => {
									if (event.button === 1) {
										event.preventDefault();
									}
								}}
								onAuxClick={(event) => {
									if (event.button === 1) {
										event.preventDefault();
										onCloseTab(tab.path);
									}
								}}
							>
								<button
									type="button"
									onClick={() => onSelectTab(tab.path)}
									className="flex items-center gap-1.5 min-w-0 h-full flex-1 px-2 border-0 bg-transparent text-inherit cursor-pointer"
								>
									{dirty ? (
										<span className="size-1.5 rounded-full bg-status-orange shrink-0" aria-hidden="true" />
									) : null}
									<span className="truncate font-mono" title={tab.path}>
										{tab.path.split("/").at(-1) ?? tab.path}
									</span>
								</button>
								<button
									type="button"
									aria-label={`Close ${tab.path}`}
									onClick={() => onCloseTab(tab.path)}
									disabled={tab.isSaving}
									className="mr-1 shrink-0 rounded-md p-1 border-0 bg-transparent cursor-pointer text-text-tertiary hover:text-text-primary hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-50"
								>
									<X size={14} />
								</button>
							</div>
						);
					})}
				</div>
			) : null}
			{activeTab ? (
				<>
					<div className="flex items-center gap-1.5 px-3 py-1 text-xs text-text-secondary border-b border-border min-h-7">
						<span className="truncate flex-1 font-mono" title={activeTab.path}>
							{activeTab.path}
						</span>
						{showReadOnlyBadge ? (
							<span className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-[10px] uppercase text-text-tertiary">
								Read-only
							</span>
						) : null}
						{isActiveTabDirty ? (
							<span className="shrink-0 rounded-sm border border-status-orange/40 px-1.5 py-0.5 text-[10px] uppercase text-status-orange">
								Unsaved
							</span>
						) : null}
						<Tooltip content={saveDisabled ? "Save unavailable" : "Save file"}>
							<button
								type="button"
								aria-label="Save file"
								onClick={() => void onSaveActiveTab()}
								disabled={saveDisabled}
								className="shrink-0 p-0.5 rounded text-text-tertiary hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
							>
								{activeTab.isSaving ? (
									<Spinner size={13} />
								) : isActiveTabDirty ? (
									<Save size={13} />
								) : (
									<Check size={13} />
								)}
							</button>
						</Tooltip>
						<Tooltip content={saveAllDisabled ? "Save all unavailable" : "Save all files"}>
							<button
								type="button"
								aria-label="Save all files"
								onClick={() => void onSaveAllTabs()}
								disabled={saveAllDisabled}
								className="shrink-0 p-0.5 rounded text-text-tertiary hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
							>
								<SaveAll size={13} />
							</button>
						</Tooltip>
						<Tooltip
							content={
								tabs.length === 0
									? "No files open"
									: hasSavingTabs
										? "Wait for saves to finish"
										: "Close all files"
							}
						>
							<button
								type="button"
								aria-label="Close all files"
								onClick={onCloseAllTabs}
								disabled={closeAllDisabled}
								className="shrink-0 p-0.5 rounded text-text-tertiary hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
							>
								<PanelTopClose size={13} />
							</button>
						</Tooltip>
						<Tooltip content={findReplaceDisabled ? "Find unavailable" : "Find and replace in file"}>
							<button
								type="button"
								aria-label="Find and replace in file"
								onClick={handleOpenFindReplace}
								disabled={findReplaceDisabled}
								className="shrink-0 p-0.5 rounded text-text-tertiary hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
							>
								<Search size={13} />
							</button>
						</Tooltip>
						<Tooltip content={reloadDisabled ? "Wait for save to finish" : "Reload file"}>
							<button
								type="button"
								aria-label="Reload file"
								onClick={() => void onReloadActiveTab()}
								disabled={reloadDisabled}
								className="shrink-0 p-0.5 rounded text-text-tertiary hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
							>
								<RotateCcw size={13} />
							</button>
						</Tooltip>
						{isMarkdown ? (
							<Tooltip content={markdownPreview ? "Show source" : "Preview markdown"}>
								<button
									type="button"
									aria-label={markdownPreview ? "Show source" : "Preview markdown"}
									onClick={toggleMarkdownPreview}
									className={cn(
										"shrink-0 p-0.5 rounded",
										markdownPreview ? "text-accent" : "text-text-tertiary hover:text-text-secondary",
									)}
								>
									{markdownPreview ? <Code size={13} /> : <BookOpen size={13} />}
								</button>
							</Tooltip>
						) : null}
						<Tooltip content="Copy file contents">
							<button
								type="button"
								aria-label="Copy file contents"
								onClick={handleCopyContent}
								disabled={activeTab.binary}
								className="shrink-0 p-0.5 rounded text-text-tertiary hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
							>
								<Copy size={13} />
							</button>
						</Tooltip>
						<Tooltip content="Copy path">
							<button
								type="button"
								aria-label="Copy path"
								onClick={handleCopyPath}
								className="shrink-0 p-0.5 rounded text-text-tertiary hover:text-text-secondary"
							>
								<Clipboard size={13} />
							</button>
						</Tooltip>
						{!showRendered ? (
							<Tooltip content={wordWrap ? "Disable word wrap" : "Enable word wrap"}>
								<button
									type="button"
									aria-label={wordWrap ? "Disable word wrap" : "Enable word wrap"}
									onClick={toggleWordWrap}
									className={cn(
										"shrink-0 p-0.5 rounded",
										wordWrap ? "text-accent" : "text-text-tertiary hover:text-text-secondary",
									)}
								>
									<WrapText size={13} />
								</button>
							</Tooltip>
						) : null}
					</div>
					{activeTab.error ? (
						<div className="flex items-center gap-2 px-3 py-1 text-xs bg-status-red text-white">
							{activeTab.error}
						</div>
					) : null}
					{activeTab.truncated ? (
						<div className="flex items-center gap-2 px-3 py-1 text-xs bg-status-orange text-surface-0">
							File truncated - reload the full file before editing
						</div>
					) : null}
					{!activeTab.truncated && activeTab.editBlockedReason ? (
						<div className="flex items-center gap-2 px-3 py-1 text-xs bg-status-orange text-surface-0">
							{activeTab.editBlockedReason}
						</div>
					) : null}
					{activeTab.binary ? (
						<div className="flex flex-1 items-center justify-center text-text-tertiary bg-surface-1">
							<div className="flex flex-col items-center gap-3">
								<FileText size={40} />
								<span className="text-sm">Binary file - cannot display</span>
							</div>
						</div>
					) : showRendered ? (
						<div className="flex-1 min-h-0 overflow-auto overscroll-contain">
							<div className="kb-markdown-rendered px-6 py-4">
								<Markdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
									{activeTab.value}
								</Markdown>
							</div>
						</div>
					) : (
						<SourceEditor
							ref={sourceEditorRef}
							path={activeTab.path}
							language={activeTab.language}
							value={activeTab.value}
							readOnly={!canEditActiveTab}
							wordWrap={wordWrap}
							scrollToLine={scrollToLine}
							onChange={onChangeActiveContent}
							onSave={onSaveActiveTab}
							onScrollToLineConsumed={onScrollToLineConsumed}
						/>
					)}
				</>
			) : null}
		</div>
	);
}
