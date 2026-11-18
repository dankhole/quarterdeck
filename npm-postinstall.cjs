// Keep source dependency installation safe before dist or dependencies exist.
const { spawnSync } = require("node:child_process");
const { existsSync, realpathSync } = require("node:fs");
const { release } = require("node:os");
const { isAbsolute, join } = require("node:path");

function occupiesGlobalPackageSlot(env) {
	if (!env.npm_config_prefix || !isAbsolute(env.npm_config_prefix)) return false;
	try {
		return realpathSync(__dirname) === realpathSync(join(env.npm_config_prefix,...(process.platform === "win32"?[]:["lib"]), "node_modules", "quarterdeck"));
	} catch {
		return false;
	}
}

function isGlobalLifecycle(env, sourceCheckout, directGlobalSlot) {
	return directGlobalSlot && env.npm_config_global === "true" &&
		["install", "update"].includes(env.npm_command) &&
		env.npm_lifecycle_event === "postinstall" &&
		!sourceCheckout;
}

function hasLocalGraphicalSession(env) {
	if (!["darwin","win32"].includes(process.platform) || env.SSH_CONNECTION || env.SSH_TTY) return false;
	const windows=process.platform === "win32";
	const result = spawnSync(windows?join(env.SystemRoot||"C:\\Windows","System32/WindowsPowerShell/v1.0/powershell.exe"):"/bin/launchctl",windows?["-NoLogo","-NoProfile","-NonInteractive","-Command","if ([Environment]::UserInteractive -and [Diagnostics.Process]::GetCurrentProcess().SessionId -gt 0) { 'Interactive' }"]:["managername"], { encoding: "utf8", windowsHide:true, timeout: windows?5_000:2_000, maxBuffer: 1_024 });
	return !result.error && result.status === 0 && result.stdout.trim() === (windows?"Interactive":"Aqua");
}

function supportsDesktopInstallation(platform, arch, osRelease) {
	return ["arm64", "x64"].includes(arch) &&
		((platform === "darwin" && Number.parseInt(osRelease, 10) >= 22) || (platform === "win32" && Number.parseInt(osRelease, 10) >= 10));
}

function shouldRunPostinstall(env, platform, arch, osRelease, sourceCheckout, desktopRelease = false, directGlobalSlot = false, graphicalSession = false) {
	return (
		isGlobalLifecycle(env, sourceCheckout, directGlobalSlot) &&
		(env.QUARTERDECK_INSTALL_MODE === "desktop" || (desktopRelease && graphicalSession && !env.SSH_CONNECTION && !env.SSH_TTY)) &&
		(!env.CI || ["0", "false"].includes(env.CI.toLowerCase())) &&
		supportsDesktopInstallation(platform, arch, osRelease)
	);
}

module.exports = { shouldRunPostinstall };

// Global npm flags are inherited by nested dependencies too; only this prefix's
// direct Quarterdeck package may install an app.
if (require.main === module && isGlobalLifecycle(process.env, existsSync(join(__dirname, ".git")), occupiesGlobalPackageSlot(process.env))) {
	const metadata = require("./package.json");
	const desktopRelease = process.platform === "win32"?metadata.quarterdeck?.windowsDesktopRelease === "unsigned-v1":["adhoc-v1", "signed-v1"].includes(metadata.quarterdeck?.desktopRelease);
	const continuousIntegration = process.env.CI && !["0", "false"].includes(process.env.CI.toLowerCase());
	const legacyPreference = existsSync(join(__dirname, "..", ".quarterdeck-install-mode.json"));
	if (!continuousIntegration && (process.env.QUARTERDECK_INSTALL_MODE === "browser" || legacyPreference)) {
		console.warn("[quarterdeck-install] Browser mode and saved browser installation preferences no longer apply. Quarterdeck now requires the desktop app; existing project data is preserved.");
	}
	const env = { ...process.env };
	const graphicalSession = !continuousIntegration && desktopRelease && hasLocalGraphicalSession(env);
	const osRelease = release();
	if (shouldRunPostinstall(env, process.platform, process.arch, osRelease, false, desktopRelease, true, graphicalSession)) {
		const entrypoint = join(__dirname, "dist", "npm-install.js");
		const retry = `${process.platform === "win32"?"$env:QUARTERDECK_INSTALL_MODE='desktop';":"QUARTERDECK_INSTALL_MODE=desktop"} npm install -g quarterdeck@${metadata.version} --foreground-scripts`;
		if (!existsSync(entrypoint)) {
			console.error(`[quarterdeck-install] The published lifecycle entrypoint is missing. Retry ${retry}; report a packaging error if it persists.`);
			process.exitCode = 1;
		} else {
			const result = spawnSync(process.execPath, [entrypoint], { env, stdio: "inherit", timeout: 190_000, killSignal: "SIGTERM" });
			if (result.error) console.error(`[quarterdeck-install] ${result.error.message}; retry ${retry}.`);
			process.exitCode = result.status === 0 && !result.error ? 0 : 1;
			if (process.exitCode === 0 && metadata.quarterdeck?.desktopRelease === "adhoc-v1") {
				console.log("[quarterdeck-install] The app is ad-hoc signed, not Apple-notarized. Before first launch, macOS may require System Settings > Privacy & Security > Open Anyway. Managed Macs may block it.");
			}
		}
	} else if (!continuousIntegration && desktopRelease && supportsDesktopInstallation(process.platform, process.arch, osRelease)) {
		console.warn("[quarterdeck-install] Desktop app installation was skipped because no verified local graphical session is available. The CLI package alone is not a working Quarterdeck app. From a local desktop session, run quarterdeck desktop install, then quarterdeck. To install explicitly from this session, retry with QUARTERDECK_INSTALL_MODE=desktop.");
	}
}
