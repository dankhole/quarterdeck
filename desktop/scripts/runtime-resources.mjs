import { cp, lstat, readdir, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

function contained(root, target) {
	const path = relative(root, target);
	return path !== "" && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

/** npm executable aliases are the only allowed links in the fresh dependency tree. */
export async function validateRuntimeDependencyLinks(runtimePath) {
	const modulesPath = join(runtimePath, "node_modules");
	const modulesInfo = await lstat(modulesPath);
	if (!modulesInfo.isDirectory() || modulesInfo.isSymbolicLink())
		throw new Error("Bundled runtime node_modules must be a real directory.");
	const root = await realpath(modulesPath);
	async function visit(directory) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink()) {
				if (basename(directory) !== ".bin" || basename(dirname(directory)) !== "node_modules")
					throw new Error(`Bundle contains a dependency symlink outside an npm .bin directory: ${path}`);
				const targetText = await readlink(path);
				let target;
				try {
					target = await realpath(path);
				} catch {
					throw new Error(`Bundle contains a dangling npm executable link: ${path}`);
				}
				if (isAbsolute(targetText) || !contained(root, target) || !(await lstat(target)).isFile())
					throw new Error(`Bundled npm executable links must be relative and remain inside node_modules: ${path}`);
			} else if (entry.isDirectory()) {
				await visit(path);
			}
		}
	}
	await visit(root);
}

/** Packager's afterCopy buildPath is Resources/app, before ASAR creation and signing. */
export async function copyRuntimeResource(runtimePath, buildPath) {
	const sourceInfo = await lstat(runtimePath);
	if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink())
		throw new Error("The staged runtime resource must be a real directory.");
	await validateRuntimeDependencyLinks(runtimePath);
	const destination = join(dirname(buildPath), "runtime");
	const existing = await lstat(destination).catch((error) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	if (existing) throw new Error("The packaged runtime destination already exists.");
	// Packager's default extraResource copy rewrites relative links to absolute
	// staging paths. Preserve their text so the helper remains self-contained.
	await cp(runtimePath, destination, {
		recursive: true,
		dereference: false,
		verbatimSymlinks: true,
		force: false,
		errorOnExist: true,
	});
	await validateRuntimeDependencyLinks(destination);
}
