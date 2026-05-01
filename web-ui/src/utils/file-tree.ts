export interface FileTreeNode {
	name: string;
	path: string;
	type: "file" | "directory";
	children: FileTreeNode[];
}

function upsertNode(nodes: FileTreeNode[], name: string, path: string, type: FileTreeNode["type"]): FileTreeNode {
	let node = nodes.find((candidate) => candidate.name === name);
	if (!node) {
		node = {
			name,
			path,
			type,
			children: [],
		};
		nodes.push(node);
	} else if (node.type === "file" && type === "directory") {
		node.type = "directory";
	}
	return node;
}

function insertPath(root: FileTreeNode[], rawPath: string, type: FileTreeNode["type"]): void {
	const parts = rawPath.split("/").filter(Boolean);
	let currentLevel = root;
	let currentPath = "";

	for (const [index, part] of parts.entries()) {
		currentPath = currentPath ? `${currentPath}/${part}` : part;
		const isLeaf = index === parts.length - 1;
		const node = upsertNode(currentLevel, part, currentPath, isLeaf ? type : "directory");

		if (!isLeaf) {
			currentLevel = node.children;
		}
	}
}

export function buildFileTree(paths: string[], directoryPaths: string[] = []): FileTreeNode[] {
	const root: FileTreeNode[] = [];

	for (const rawPath of directoryPaths) {
		insertPath(root, rawPath, "directory");
	}
	for (const rawPath of paths) {
		insertPath(root, rawPath, "file");
	}

	function sortNodes(nodes: FileTreeNode[]): FileTreeNode[] {
		return nodes
			.map((node) => ({ ...node, children: sortNodes(node.children) }))
			.sort((a, b) => {
				if (a.type === b.type) {
					return a.name.localeCompare(b.name);
				}
				return a.type === "directory" ? -1 : 1;
			});
	}

	return sortNodes(root);
}
