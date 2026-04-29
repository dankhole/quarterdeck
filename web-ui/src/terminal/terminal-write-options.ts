export interface TerminalWriteOptions {
	ackBytes?: number;
	notifyText?: string | null;
	/**
	 * Rendering optimization for live IO output. Restore snapshots, resets,
	 * and local status text should leave this off so they flush in strict order.
	 */
	batch?: boolean;
}
