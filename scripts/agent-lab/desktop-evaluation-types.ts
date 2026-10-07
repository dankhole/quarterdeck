/**
 * Test-only structural port for methods evaluated inside Electron's main process.
 * Playwright's Electron type resolves to an optional `electron` dependency. Keep
 * root/npm/browser checks independent of the desktop package's dependencies.
 */
interface DesktopMenuItem {
	enabled: boolean;
	click: (item: DesktopMenuItem, window: undefined, event: { triggeredByAccelerator: boolean }) => void;
}

export interface DesktopReobserveEvaluationModule {
	app: { isPackaged: boolean; getAppPath: () => string; getPath: (name: "userData") => string };
	BrowserWindow: {
		getAllWindows: () => Array<{
			id: number;
			webContents: {
				id: number;
				getURL: () => string;
				getOSProcessId: () => number;
				executeJavaScript: (code: string) => Promise<unknown>;
			};
		}>;
	};
}

export interface DesktopMenuEvaluationModule {
	Menu: {
		getApplicationMenu: () => {
			getMenuItemById: (id: string) => DesktopMenuItem | null;
		} | null;
	};
}

export interface DesktopDocumentEvaluationModule {
	BrowserWindow: {
		getAllWindows: () => Array<{ id: number; webContents: { id: number; getURL: () => string } }>;
	};
}

export interface DesktopEvaluationModule {
	app: {
		isPackaged: boolean;
		getAppPath: () => string;
		getPath: (name: "userData") => string;
		emit: (event: "activate") => boolean;
		on: (event: "second-instance", listener: () => void) => void;
		__quarterdeckLabSecondInstanceCount?: number;
	};
	BrowserWindow: {
		getAllWindows: () => Array<{
			id: number;
			isVisible: () => boolean;
			isFocused: () => boolean;
			getBounds: () => { x: number; y: number; width: number; height: number };
			setSize: (width: number, height: number) => void;
			close: () => void;
			webContents: {
				getURL: () => string;
				getOSProcessId: () => number;
				forcefullyCrashRenderer: () => void;
			};
		}>;
	};
}
