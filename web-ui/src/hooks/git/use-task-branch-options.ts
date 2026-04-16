import { useMemo } from "react";

import type { RuntimeGitRepositoryInfo } from "@/runtime/types";

interface TaskBranchOption {
	value: string;
	label: string;
}

interface UseTaskBranchOptionsInput {
	workspaceGit: RuntimeGitRepositoryInfo | null;
	configDefaultBaseRef?: string;
}

interface UseTaskBranchOptionsResult {
	createTaskBranchOptions: TaskBranchOption[];
	defaultTaskBranchRef: string;
	/** True when the default was set via the config field (overrides last-used-branch memory). */
	isConfigDefaultBaseRef: boolean;
}

export function useTaskBranchOptions({
	workspaceGit,
	configDefaultBaseRef,
}: UseTaskBranchOptionsInput): UseTaskBranchOptionsResult {
	const configRef = configDefaultBaseRef?.trim() || "";

	const createTaskBranchOptions = useMemo(() => {
		if (!workspaceGit) {
			return [] as TaskBranchOption[];
		}

		// Resolve the effective default: config pin → git detection.
		const effectiveDefault = configRef || workspaceGit.defaultBranch;

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

		const currentIsDefault = workspaceGit.currentBranch != null && workspaceGit.currentBranch === effectiveDefault;
		append(workspaceGit.currentBranch, currentIsDefault ? "(current, default)" : "(current)");
		append(effectiveDefault, "(default)");
		for (const branch of workspaceGit.branches) {
			append(branch);
		}
		append(workspaceGit.defaultBranch);

		return options;
	}, [configRef, workspaceGit]);

	const configRefIsValid = configRef !== "" && createTaskBranchOptions.some((opt) => opt.value === configRef);

	const defaultTaskBranchRef = useMemo(() => {
		if (configRefIsValid) {
			return configRef;
		}
		if (!workspaceGit) {
			return "";
		}
		return workspaceGit.defaultBranch ?? workspaceGit.currentBranch ?? createTaskBranchOptions[0]?.value ?? "";
	}, [configRef, configRefIsValid, createTaskBranchOptions, workspaceGit]);

	return {
		createTaskBranchOptions,
		defaultTaskBranchRef,
		isConfigDefaultBaseRef: configRefIsValid,
	};
}
