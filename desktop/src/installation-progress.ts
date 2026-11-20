import { app, BrowserWindow } from "electron";

/** A static window with no bridge while the admitted app verifies its installed files. */
export function showInstallationProgress(): () => void {
	let window: BrowserWindow | undefined;
	let finished = false;
	void app
		.whenReady()
		.then(async () => {
			if (finished) return;
			window = new BrowserWindow({
				width: 460,
				height: 180,
				title: "Starting Quarterdeck",
				show: false,
				resizable: false,
				closable: false,
				backgroundColor: "#24292e",
				webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
			});
			window.removeMenu();
			const html = `<body style="padding:24px;color:#e6edf3;background:#24292e;font:16px system-ui"><main role="status"><strong>Starting Quarterdeck</strong><p>Verifying the desktop installation…</p></main></body>`;
			await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
			if (!finished && !window.isDestroyed()) window.show();
		})
		.catch(() => undefined);
	return () => {
		finished = true;
		if (window && !window.isDestroyed()) window.destroy();
	};
}
