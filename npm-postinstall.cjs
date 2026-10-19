// Keep source dependency installation safe before dist or dependencies exist.
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { release } = require("node:os");
const { join } = require("node:path");

function shouldRunPostinstall(env, platform, arch, osRelease, sourceCheckout) {
	return (
		env.npm_config_global === "true" &&
		["install", "update"].includes(env.npm_command) &&
		env.npm_lifecycle_event === "postinstall" &&
		env.QUARTERDECK_INSTALL_MODE === "desktop" &&
		(!env.CI || ["0", "false"].includes(env.CI.toLowerCase())) &&
		!sourceCheckout &&
		platform === "darwin" &&
		["arm64", "x64"].includes(arch) &&
		Number.parseInt(osRelease, 10) >= 22
	);
}

module.exports = { shouldRunPostinstall };

if (require.main === module && shouldRunPostinstall(process.env, process.platform, process.arch, release(), existsSync(join(__dirname, ".git")))) {
	const entrypoint = join(__dirname, "dist", "npm-install.js");
	const version = require("./package.json").version;
	const retry = `QUARTERDECK_INSTALL_MODE=desktop npm install -g quarterdeck@${version} --foreground-scripts`;
	if (!existsSync(entrypoint)) {
		console.error(`[quarterdeck-install] The published lifecycle entrypoint is missing. Retry ${retry}; report a packaging error if it persists.`);
		process.exitCode = 1;
	} else {
		const result = spawnSync(process.execPath, [entrypoint], { stdio: "inherit", timeout: 190_000, killSignal: "SIGTERM" });
		if (result.error) console.error(`[quarterdeck-install] ${result.error.message}; retry ${retry}.`);
		process.exitCode = result.status === 0 && !result.error ? 0 : 1;
	}
}
