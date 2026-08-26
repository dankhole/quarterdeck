export const CODEX_APPROVALS_REVIEWERS = ["inherit", "user", "auto_review", "dangerously_bypass"] as const;

export type CodexApprovalsReviewer = (typeof CODEX_APPROVALS_REVIEWERS)[number];
