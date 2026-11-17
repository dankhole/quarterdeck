// Keep source dependency installation safe before dist or dependencies exist.
const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
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

function shouldRunPostinstall(env, platform, arch, osRelease, sourceCheckout, desktopRelease = false, directGlobalSlot = false, graphicalSession = false) {
	return (
		isGlobalLifecycle(env, sourceCheckout, directGlobalSlot) &&
		(env.QUARTERDECK_INSTALL_MODE === "desktop" || (!env.QUARTERDECK_INSTALL_MODE && desktopRelease && graphicalSession && !env.SSH_CONNECTION && !env.SSH_TTY)) &&
		(!env.CI || ["0", "false"].includes(env.CI.toLowerCase())) &&
		((platform === "darwin" && Number.parseInt(osRelease,10)>=22) || (platform === "win32" && Number.parseInt(osRelease,10)>=10)) &&
		["arm64", "x64"].includes(arch)
	);
}

module.exports = { shouldRunPostinstall };

// Global npm flags are inherited by nested dependencies too; only this prefix's
// direct Quarterdeck package may install an app or change its browser preference.
if (require.main === module && isGlobalLifecycle(process.env, existsSync(join(__dirname, ".git")), occupiesGlobalPackageSlot(process.env))) {
	const metadata = require("./package.json");
	const desktopRelease = process.platform === "win32"?metadata.quarterdeck?.windowsDesktopRelease === "unsigned-v1":["adhoc-v1", "signed-v1"].includes(metadata.quarterdeck?.desktopRelease);
	const preferencePath = join(__dirname, "..", ".quarterdeck-install-mode.json");
	let browserPreference = false;
	if (preferencePath) {
		try {
			const preference = JSON.parse(readFileSync(preferencePath, "utf8"));
			browserPreference = preference?.schemaVersion === 1 && preference.mode === "browser";
		} catch {
			// Absent/skipped hooks do not establish an opt-out.
		}
	}
	const mode = process.env.QUARTERDECK_INSTALL_MODE || (browserPreference || !desktopRelease ? "browser" : undefined);
	// This npm-prefix preference survives package replacement; it is not runtime
	// state or app ownership. Explicit desktop installation clears the opt-out.
	if (preferencePath && mode === "browser") {
		writeFileSync(preferencePath, JSON.stringify({ schemaVersion: 1, mode: "browser" }) + "\n", { mode: 0o600 });
	} else if (preferencePath && mode === "desktop") {
		rmSync(preferencePath, { force: true });
	}
	const env = { ...process.env, QUARTERDECK_INSTALL_MODE: mode };
	const graphicalSession = !mode && desktopRelease && hasLocalGraphicalSession(env);
	if (shouldRunPostinstall(env, process.platform, process.arch, release(), false, desktopRelease, true, graphicalSession)) {
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
	}
}
