import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const signingSecrets = [
	"DESKTOP_MAC_CERTIFICATE_BASE64",
	"DESKTOP_MAC_CERTIFICATE_PASSWORD",
	"DESKTOP_MAC_NOTARY_KEY_BASE64",
];
export const signingVariables = [
	"DESKTOP_MAC_SIGNING_IDENTITY",
	"DESKTOP_MAC_TEAM_ID",
	"DESKTOP_MAC_NOTARY_KEY_ID",
	"DESKTOP_MAC_NOTARY_ISSUER",
];

const environment = "desktop-signing";
// Project values inside gh before returning output to this process. Never print
// raw API output, subprocess errors, reviewer identities, or variable values.
const variableProjection =
	'{total_count, variables: [.variables[] | {name, present: (.value | test("\\\\S")), enabled: (if .name == "QUARTERDECK_DESKTOP_RELEASES" then .value == "1" else false end)}]}';

function records(pages, key) {
	if (!Array.isArray(pages) || pages.length === 0) throw new Error("Invalid pages");
	return pages.flatMap((page) => {
		if (!Array.isArray(page?.[key])) throw new Error("Invalid collection");
		return page[key];
	});
}

/** Read-only metadata audit. The injected runner uses the spawnSync contract. */
export function signingPreflight({ repository = "dankhole/quarterdeck", runGh = spawnSync } = {}) {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(repository)) {
		throw new Error("Expected --repository owner/repository");
	}
	const base = `repos/${repository}`;
	const envBase = `${base}/environments/${environment}`;
	const checks = [];
	function check(id, inspect) {
		try {
			const { ok, detail } = inspect();
			checks.push({ id, status: ok ? "pass" : "fail", detail });
		} catch {
			checks.push({
				id,
				status: "unknown",
				detail:
					"Metadata unavailable or unrecognized; check gh authentication, repository access, and environment support. No readiness inferred.",
			});
		}
	}
	function get(endpoint, { paginate = false, projection } = {}) {
		const pages = [];
		let count = 0;
		for (let page = 1; page <= 100; page++) {
			const url = paginate ? `${endpoint}&page=${page}` : endpoint;
			const args = ["api", url, "--method", "GET"];
			if (projection) args.push("--jq", projection);
			const result = runGh("gh", args, {
				encoding: "utf8",
				stdio: "pipe",
				timeout: 30_000,
				maxBuffer: 2 * 1024 * 1024,
			});
			if (result.error || result.signal || result.status !== 0) throw new Error("Metadata read failed");
			const data = JSON.parse(result.stdout);
			if (!paginate) return data;
			const collections = Object.values(data ?? {}).filter(Array.isArray);
			if (!Number.isInteger(data?.total_count) || data.total_count < 0 || collections.length !== 1)
				throw new Error("Unknown page shape");
			count += collections[0].length;
			pages.push(data);
			if (data.total_count !== pages[0].total_count || count > data.total_count)
				throw new Error("Changing collection");
			if (count === data.total_count) return pages;
			if (collections[0].length !== 100) throw new Error("Incomplete collection");
		}
		throw new Error("Metadata pagination limit exceeded");
	}

	let environmentExists;
	check("environment-exists", () => {
		const environments = records(
			get(`${base}/environments?per_page=100`, {
				paginate: true,
				projection: "{total_count, environments: [.environments[] | {name}]}",
			}),
			"environments",
		);
		if (environments.some((entry) => typeof entry.name !== "string")) throw new Error("Unknown environment shape");
		environmentExists = environments.some((entry) => entry.name === environment);
		return {
			ok: environmentExists,
			detail: environmentExists
				? "Protected environment exists."
				: "desktop-signing is absent from the readable repository environment list; create and protect it before provisioning.",
		};
	});
	function checkEnvironment(id, inspect) {
		check(id, () => {
			if (environmentExists === false)
				return { ok: false, detail: "desktop-signing environment is missing; configuration cannot be ready." };
			if (environmentExists !== true) throw new Error("Environment existence unknown");
			return inspect();
		});
	}
	checkEnvironment("environment-protection", () => {
		const config = get(envBase);
		if (!Array.isArray(config.protection_rules) || typeof config.can_admins_bypass !== "boolean")
			throw new Error("Unknown protection shape");
		const reviews = config.protection_rules.filter((rule) => rule.type === "required_reviewers");
		if (reviews.length === 1 && typeof reviews[0].prevent_self_review !== "boolean")
			throw new Error("Unknown self-review policy shape");
		const ok =
			config.can_admins_bypass === false &&
			reviews.length === 1 &&
			reviews[0].prevent_self_review === false &&
			Array.isArray(reviews[0].reviewers) &&
			reviews[0].reviewers.length > 0 &&
			reviews[0].reviewers.every(
				(entry) =>
					["User", "Team"].includes(entry.type) && Number.isInteger(entry.reviewer?.id) && entry.reviewer.id > 0,
			) &&
			config.deployment_branch_policy?.custom_branch_policies === true &&
			config.deployment_branch_policy?.protected_branches === false;
		return {
			ok,
			detail:
				"Solo-maintainer policy: require manual reviewer approval, allow self-review, disallow administrator bypass, and select custom deployment branches/tags.",
		};
	});
	checkEnvironment("deployment-refs", () => {
		const policies = records(
			get(`${envBase}/deployment-branch-policies?per_page=100`, { paginate: true }),
			"branch_policies",
		);
		const allowed = new Set(["branch:main", "tag:v*.*.*"]);
		const actual = policies.map((policy) => `${policy.type}:${policy.name}`);
		return {
			ok: actual.length === 2 && new Set(actual).size === 2 && actual.every((policy) => allowed.has(policy)),
			detail:
				"Allow exactly branch main and tag v*.*.*; broad, additional, or untyped policies require correction or manual review.",
		};
	});
	checkEnvironment("environment-secrets", () => {
		const secrets = records(
			get(`${envBase}/secrets?per_page=100`, {
				paginate: true,
				projection: "{total_count, secrets: [.secrets[] | {name}]}",
			}),
			"secrets",
		);
		if (secrets.some((secret) => typeof secret.name !== "string")) throw new Error("Unknown secret shape");
		const missing = signingSecrets.filter((name) => !secrets.some((secret) => secret.name === name));
		return {
			ok: missing.length === 0,
			detail: missing.length
				? `Missing environment secret names: ${missing.join(", ")}.`
				: "All required environment secret names exist; contents, expiry, and usability are not verified.",
		};
	});
	checkEnvironment("environment-variables", () => {
		const variables = records(
			get(`${envBase}/variables?per_page=100`, { paginate: true, projection: variableProjection }),
			"variables",
		);
		if (variables.some((variable) => typeof variable.name !== "string" || typeof variable.present !== "boolean"))
			throw new Error("Unknown variable shape");
		const missing = signingVariables.filter(
			(name) => !variables.some((variable) => variable.name === name && variable.present),
		);
		return {
			ok: missing.length === 0,
			detail: missing.length
				? `Missing or blank environment variables: ${missing.join(", ")}.`
				: "All required environment variables are nonblank; identity/team/key agreement is not verified.",
		};
	});
	check("publication-disabled", () => {
		const variables = records(
			get(`${base}/actions/variables?per_page=100`, { paginate: true, projection: variableProjection }),
			"variables",
		);
		if (variables.some((variable) => typeof variable.name !== "string" || typeof variable.enabled !== "boolean"))
			throw new Error("Unknown repository variable shape");
		const gates = variables.filter((variable) => variable.name === "QUARTERDECK_DESKTOP_RELEASES");
		if (gates.length > 1 || gates.some((gate) => typeof gate.enabled !== "boolean"))
			throw new Error("Unknown publication gate shape");
		return {
			ok: gates.length === 0 || !gates[0].enabled,
			detail:
				"Keep repository QUARTERDECK_DESKTOP_RELEASES unset (or not 1) until actual desktop acceptance gates pass; this command never enables it.",
		};
	});
	return {
		schemaVersion: 1,
		repository,
		environment,
		metadataReady: checks.every((entry) => entry.status === "pass"),
		checks,
		limitations: [
			"Metadata only: no certificate/private-key access, signing, notarization, build, dispatch, or GitHub mutation.",
			"Does not verify Apple membership, certificate validity/private-key match, API permissions, signature/team, staples, Gatekeeper, or native execution.",
			"Does not establish main review enforcement, immutable tag rules, reviewer trust/maintainer identity, organization variable/secret policy, or protection of workflow/dependency changes. Maintainer review is required.",
			"Solo-maintainer self-approval is not independent review; a compromised maintainer account can approve signing. Inspect the exact immutable source, dependencies, and workflow changes before approval.",
			"A pass is readiness to request a protected candidate build, not permission to publish or evidence of release acceptance.",
		],
	};
}

export function main(args = process.argv.slice(2), options = {}) {
	if (args.length !== 0 && (args.length !== 2 || args[0] !== "--repository"))
		throw new Error("Usage: node .github/scripts/desktop-signing-preflight.mjs [--repository owner/repository]");
	const result = signingPreflight({ ...options, ...(args.length ? { repository: args[1] } : {}) });
	console.log(JSON.stringify(result, null, 2));
	return result.metadataReady ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		process.exitCode = main();
	} catch {
		console.error("Usage: node .github/scripts/desktop-signing-preflight.mjs [--repository owner/repository]");
		process.exitCode = 1;
	}
}
