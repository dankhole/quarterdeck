import { X } from "lucide-react";
import { useMemo } from "react";
import { Spinner } from "@/components/ui/spinner";
import {
	CODE_NAVIGATION_LABELS,
	type CodeNavigationResult,
	groupCodeNavigationLocations,
} from "@/hooks/git/code-navigation";
import type { CodeNavigationLocation } from "@/runtime/types";

export function CodeNavigationResults({
	result,
	onDismiss,
	onNavigate,
}: {
	result: CodeNavigationResult;
	onDismiss: () => void;
	onNavigate: (location: CodeNavigationLocation) => void;
}): React.ReactElement {
	const groups = useMemo(
		() => groupCodeNavigationLocations(result.status === "locations" ? result.locations : []),
		[result],
	);
	return (
		<section
			aria-label="Code navigation results"
			className="max-h-64 shrink-0 overflow-auto border-t border-border bg-surface-0 text-xs"
		>
			<div className="sticky top-0 flex items-center gap-2 border-b border-border bg-surface-0 px-3 py-2">
				<span className="flex-1 font-medium text-text-primary">{CODE_NAVIGATION_LABELS[result.operation]}</span>
				<button
					type="button"
					aria-label="Close code navigation results"
					onClick={onDismiss}
					className="rounded p-1 text-text-secondary hover:bg-surface-3"
				>
					<X size={14} />
				</button>
			</div>
			{result.status === "locations" ? (
				<p className="my-2 px-3 text-text-tertiary">
					From <span className="font-mono">{result.sourcePath}</span>
				</p>
			) : null}
			{result.status === "busy" ? (
				<p role="status" className="flex items-center gap-2 px-3 text-text-secondary">
					<Spinner size={14} />
					Waiting for the language server. First use may take longer while it starts.
				</p>
			) : null}
			{result.status === "error" || result.status === "unavailable" ? (
				<p role="status" className="px-3 text-text-secondary">
					{result.message}
				</p>
			) : null}
			{result.status === "hover" ? (
				<pre className="whitespace-pre-wrap break-words px-3 font-mono text-text-primary">
					{result.contents || "No type information found at this position."}
				</pre>
			) : null}
			{result.status === "locations" ? (
				<>
					{result.locations.length === 0 ? (
						<p role="status" className="px-3 text-text-secondary">
							{result.operation === "definition"
								? "No definition found at this position."
								: "No references found at this position."}
						</p>
					) : null}
					{Array.from(groups, ([path, locations]) => (
						<div key={path} className="px-3 py-1.5">
							<div className="break-all font-mono text-text-secondary">{path}</div>
							{locations.map((location, index) => (
								<button
									type="button"
									key={`${location.range.start.line}:${location.range.start.character}:${index}`}
									onClick={() => onNavigate(location)}
									className="my-0.5 block w-full rounded px-2 py-1 text-left text-accent hover:bg-surface-2"
								>
									Line {location.range.start.line + 1}, column {location.range.start.character + 1}
								</button>
							))}
						</div>
					))}
					{result.truncated ? (
						<p role="status" className="px-3 text-text-tertiary">
							The language server returned more results than can be shown.
						</p>
					) : null}
				</>
			) : null}
		</section>
	);
}
