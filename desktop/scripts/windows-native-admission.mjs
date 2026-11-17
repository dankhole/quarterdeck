import { spawnSync } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { desktopRoot, requireNativeDesktopTarget } from "./paths.mjs";
import { run } from "./process.mjs";
import { windowsDesktopIcon } from "./windows-icon.mjs";

/** Compile with the installed native MSVC toolchain, without depending on shell profile setup. */
export async function buildWindowsAdmission(output, { test = false, gui = false, labProfileRoot } = {}) {
	requireNativeDesktopTarget(process.arch);
	if (process.platform !== "win32") throw new Error("Windows admission requires a native Windows compiler.");
	const directory = dirname(resolve(output));
	await mkdir(directory, { recursive: true });
	let labHeader;
	if (labProfileRoot !== undefined) {
		const profile = await realpath(labProfileRoot);
		if (!basename(dirname(profile)).startsWith("quarterdeck-agent-lab-") || basename(profile) !== "native-profile")
			throw new Error("A compiled synthetic profile must belong to a disposable Agent Lab fixture.");
		labHeader = join(directory, "synthetic-profile.h");
		await writeFile(labHeader, `#define QUARTERDECK_ADMISSION_LAB_PROFILE L${JSON.stringify(profile)}\n`, "utf8");
	}
	const vswhere = join(
		process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
		"Microsoft Visual Studio",
		"Installer",
		"vswhere.exe",
	);
	const installation = spawnSync(
		vswhere,
		[
			"-latest",
			"-products",
			"*",
			"-requires",
			"Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
			"-property",
			"installationPath",
		],
		{ encoding: "utf8", windowsHide: true, timeout: 10000 },
	);
	if (installation.error || installation.status !== 0 || !installation.stdout.trim())
		throw new Error("Install native Visual Studio C++ Build Tools to compile Windows admission.");
	const toolchain = join(installation.stdout.trim(), "VC", "Auxiliary", "Build", "vcvarsall.bat");
	await windowsDesktopIcon(join(directory, "quarterdeck.ico"));
	await writeFile(join(directory, "admission.rc"), '1 ICON "quarterdeck.ico"\r\n');
	const argumentsForCompiler = [
		"/nologo",
		"/W4",
		"/WX",
		"/O2",
		"/utf-8",
		"/DUNICODE",
		"/D_UNICODE",
		"/D_CRT_SECURE_NO_WARNINGS",
		...(test ? ["/DQUARTERDECK_ADMISSION_TEST"] : []),
		...(labHeader ? [`/FI${labHeader}`] : []),
		join(desktopRoot, "native", "windows-installation-admission.c"),
		join(desktopRoot, "native", "windows-shortcut.cpp"),
		join(desktopRoot, "native", "windows-update-window.cpp"),
		join(desktopRoot, "native", "windows-launch-custody.c"),
		`/Fe${resolve(output)}`,
		`/Fo${directory}/`,
		"shell32.lib",
		"advapi32.lib",
		"ole32.lib",
		"oleaut32.lib",
		"uuid.lib",
		"propsys.lib",
		"admission.res",
	];
	const response = join(directory, "windows-admission.rsp");
	await writeFile(
		response,
		Buffer.from(`\uFEFF${argumentsForCompiler.map((argument) => `"${argument}"`).join("\r\n")}`, "utf16le"),
	);
	const batch = join(directory, "build-windows-admission.cmd");
	const batchPath = (path) => {
		if (/["\r\n]/u.test(path)) throw new Error("Invalid compiler path.");
		return `"${path.replaceAll("%", "%%")}"`;
	};
	await writeFile(
		batch,
		`@echo off\r\ncall ${batchPath(toolchain)} ${process.arch === "arm64" ? "arm64" : "x64"} >nul\r\nif errorlevel 1 exit /b 1\r\nrc.exe /nologo /fo admission.res admission.rc\r\nif errorlevel 1 exit /b 1\r\ncl.exe @windows-admission.rsp${gui ? " /link /SUBSYSTEM:WINDOWS /ENTRY:wmainCRTStartup" : ""}\r\nexit /b %errorlevel%\r\n`,
	);
	run(
		join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
		["/d", "/s", "/c", "build-windows-admission.cmd"],
		{ cwd: directory, windowsHide: true, timeout: 120000 },
	);
	return resolve(output);
}

/** Wrap the renamed, fused hosts; compile products stay outside the app's resource tree. */
export async function installWindowsNativeAdmission(appPath) {
	const bootstrap = join(desktopRoot, ".cache", "native", process.arch, "admission.exe");
	await buildWindowsAdmission(bootstrap, { gui: true });
	for (const [entry, host] of [
		["Quarterdeck.exe", "QuarterdeckHost.exe"],
		["resources/runtime/bin/node.exe", "resources/runtime/bin/nodeHost.exe"],
	]) {
		const original = join(appPath, entry);
		if (!(await lstat(original)).isFile()) throw new Error("Missing Windows desktop host executable.");
		await rename(original, join(appPath, host));
		await copyFile(bootstrap, original);
	}
	await copyFile(bootstrap, join(appPath, "resources", "runtime", "installation-admission.exe"));
	const bundle = JSON.parse(await readFile(join(appPath, "resources/runtime/bundle-manifest.json"), "utf8"));
	const metadata = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"));
	await writeFile(
		join(appPath, "resources/desktop-shell.json"),
		JSON.stringify({
			name: metadata.name,
			bundleId: metadata.quarterdeckDesktop.bundleId,
			version: metadata.version,
			buildId: bundle.buildId,
			sourceSha: bundle.sourceSha,
		}),
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const { values } = parseArgs({ options: { output: { type: "string" }, test: { type: "boolean", default: false } } });
	if (!values.output) throw new Error("Pass --output for the native admission executable.");
	await buildWindowsAdmission(values.output, { test: values.test });
}
