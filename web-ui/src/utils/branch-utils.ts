const BRANCH_PREFIX = "quarterdeck/";
const MAX_BRANCH_LENGTH = 60;

export function slugifyBranchName(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/\//g, "-")
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/[\s-]+/g, "-")
		.replace(/^-+|-+$/g, "");

	if (!slug) {
		return "";
	}

	const maxSlugLength = MAX_BRANCH_LENGTH - BRANCH_PREFIX.length;
	const truncated = slug.length > maxSlugLength ? slug.slice(0, maxSlugLength).replace(/-+$/, "") : slug;

	return `${BRANCH_PREFIX}${truncated}`;
}
