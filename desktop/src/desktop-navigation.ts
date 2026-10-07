export interface DesktopNavigationOptions {
	load: () => Promise<void>;
	stop: () => void;
	hasCommitted: () => boolean;
	restoreSurvivingDocument: () => void;
	releaseTransition: () => void;
	deadlineMs?: number;
}

/** A permanent acknowledged input hold protects navigation; commit evidence determines whether old authority can return. */
export async function navigateDesktopDocument(options: DesktopNavigationOptions): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let cancellationConfirmed = true;
	try {
		await Promise.race([
			options.load(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					try {
						options.stop();
					} catch {
						cancellationConfirmed = false;
					}
					reject(new Error("Desktop navigation deadline exceeded."));
				}, options.deadlineMs ?? 30_000);
			}),
		]);
	} catch {
		if (cancellationConfirmed && !options.hasCommitted()) {
			options.restoreSurvivingDocument();
			options.releaseTransition();
		}
		throw new Error("Desktop navigation did not complete.");
	} finally {
		if (timer) clearTimeout(timer);
	}
}
