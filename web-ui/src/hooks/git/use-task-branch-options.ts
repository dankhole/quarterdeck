import { useMemo } from "react";

import type { RuntimeGitRepositoryInfo } from "@/runtime/types";

interface TaskBranchOption {
	value: string;
	label: string;
}

interface UseTaskBranchOptionsInput {
	projectGit: RuntimeGitRepositoryInfo | null;
	configDefaultBaseRef?: string;
}

interface UseTaskBranchOptionsResult {
	createTaskBranchOptions: TaskBranchOption[];
	defaultTaskBranchRef: string;
	/** True when the default was set via the config field (overrides last-used-branch memory). */
	isConfigDefaultBaseRef: boolean;
}

export function useTaskBranchOptions({
	projectGit,
	configDefaultBaseRef,
}: UseTaskBranchOptionsInput): UseTaskBranchOptionsResult {
	const configRef = configDefaultBaseRef?.trim() || "";

	const createTaskBranchOptions = useMemo(() => {
		if (!projectGit) {
			return [] as TaskBranchOption[];
		}

		// Resolve the effective default: config pin → git detection.
		const hasConfigPin = configRef !== "";
		const effectiveDefault = configRef || projectGit.defaultBranch;

		const options: TaskBranchOption[] = [];
		const seen = new Set<string>();
		const append = (value: string | null | undefined, labelSuffix?: string) => {
			if (!value || seen.has(value)) {
				return;
			}
			seen.add(value);
			options.push({
				value,
				label: labelSuffix ? `${value} ${labelSuffix}` : value,
			});
		};

		const currentIsDefault =
			hasConfigPin && projectGit.currentBranch != null && projectGit.currentBranch === effectiveDefault;
		append(projectGit.currentBranch, currentIsDefault ? "(current, default)" : "(current)");
		if (hasConfigPin) {
			append(effectiveDefault, "(default)");
		}
		for (const branch of projectGit.branches) {
			append(branch);
		}
		append(projectGit.defaultBranch);

		return options;
	}, [configRef, projectGit]);

	const configRefIsValid = configRef !== "" && createTaskBranchOptions.some((opt) => opt.value === configRef);

	const defaultTaskBranchRef = useMemo(() => {
		if (configRefIsValid) {
			return configRef;
		}
		if (!projectGit) {
			return "";
		}
		return projectGit.defaultBranch ?? projectGit.currentBranch ?? createTaskBranchOptions[0]?.value ?? "";
	}, [configRef, configRefIsValid, createTaskBranchOptions, projectGit]);

	return {
		createTaskBranchOptions,
		defaultTaskBranchRef,
		isConfigDefaultBaseRef: configRefIsValid,
	};
}
