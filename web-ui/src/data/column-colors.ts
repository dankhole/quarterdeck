/**
 * Centralized status color definitions.
 *
 * Every UI surface that represents a board or session status — card badges,
 * project-sidebar pills, column-header indicators — derives its color from
 * this module.  To change "running = blue" across the entire app, update it
 * here once.
 */

// ---------------------------------------------------------------------------
// Badge colors — session status tags on task cards & terminal panel
// ---------------------------------------------------------------------------

export const statusBadgeColors = {
	neutral: "bg-surface-3 text-text-secondary",
	running: "bg-accent/15 text-accent",
	review: "bg-status-green/15 text-status-green",
	needs_input: "bg-status-orange/15 text-status-orange",
	error: "bg-status-red/15 text-status-red",
} as const;

export type StatusBadgeStyle = keyof typeof statusBadgeColors;

// ---------------------------------------------------------------------------
// Pill colors — task-count badges in the project navigation sidebar
// ---------------------------------------------------------------------------

export const statusPillColors = {
	backlog: "bg-text-primary/15 text-text-primary",
	in_progress: "bg-accent/20 text-accent",
	review: "bg-status-green/20 text-status-green",
} as const;

// ---------------------------------------------------------------------------
// Column indicator colors — SVG fills for column headers
// ---------------------------------------------------------------------------

export const columnIndicatorColors: Record<string, string> = {
	backlog: "var(--color-text-primary)",
	in_progress: "var(--color-accent)",
	review: "var(--color-status-green)",
	trash: "var(--color-status-red)",
};
