import open from "open";

type BrowserOpenDeps = {
	warn: (message: string) => void;
};

export function openInBrowser(url: string, deps?: BrowserOpenDeps): void {
	try {
		// On Linux the `open` package ships a bundled xdg-open and uses it
		// instead of the system one. Force the system xdg-open so PATH-based
		// overrides (e.g. BROWSER wrappers, integration test stubs) work.
		const options =
			process.platform === "linux" ? { app: { name: "xdg-open" } } : {};
		open(url, options);
	} catch (err) {
		const warn = deps?.warn ?? (() => {});
		warn(`Could not open browser automatically. Open this URL manually: ${url}`);
	}
}
