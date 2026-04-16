import { GitCompareArrows } from "lucide-react";

export function GitViewLoadingPanel(): React.ReactElement {
	return (
		<div className="flex flex-1 min-w-0 min-h-0 bg-surface-0">
			<div className="flex flex-1 flex-col" style={{ borderRight: "1px solid var(--color-divider)" }}>
				<div className="p-2.5 pb-1.5">
					<div className="flex items-center gap-2 mb-2.5">
						<div className="kb-skeleton h-3.5 rounded-sm" style={{ width: "62%" }} />
						<div className="kb-skeleton h-4 rounded-full" style={{ width: 42 }} />
					</div>
					<div className="kb-skeleton h-3 rounded-sm mb-1.5" style={{ width: "92%" }} />
					<div className="kb-skeleton h-3 rounded-sm mb-1.5" style={{ width: "84%" }} />
					<div className="kb-skeleton h-3 rounded-sm mb-1.5" style={{ width: "95%" }} />
					<div className="kb-skeleton h-3 rounded-sm mb-1.5" style={{ width: "79%" }} />
					<div className="kb-skeleton h-3 rounded-sm mb-1.5" style={{ width: "88%" }} />
					<div className="kb-skeleton h-3 rounded-sm" style={{ width: "76%" }} />
				</div>
				<div className="flex-1" />
			</div>
		</div>
	);
}

export function GitViewEmptyPanel({ title }: { title: string }): React.ReactElement {
	return (
		<div className="flex flex-1 min-w-0 min-h-0 bg-surface-0">
			<div className="flex flex-1 items-center justify-center">
				<div className="flex flex-col items-center justify-center gap-3 py-12 text-text-tertiary">
					<GitCompareArrows size={40} />
					<h3 className="font-semibold text-text-secondary">{title}</h3>
				</div>
			</div>
		</div>
	);
}
