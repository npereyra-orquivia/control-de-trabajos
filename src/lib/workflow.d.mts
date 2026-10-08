import type { Job, JobKind, ReviewAction, Status, StatusDefinition } from "../types";

export const ALL_STATUSES: StatusDefinition[];
export function jobKind(jobOrKind?: Pick<Job, "job_kind"> | JobKind | { job_kind?: JobKind } | null): JobKind;
export function statusLabel(status: Status | string): string;
export function getJobStages(jobOrKind: JobKind | Pick<Job, "job_kind" | "status" | "rework_kind">): StatusDefinition[];
export function getJobMetrics(jobs: readonly Job[], kind?: JobKind): {
  total: number;
  completed: number;
  pending: number;
  totalUnits: number;
  completedUnits: number;
  pendingUnits: number;
  pendingReview: number;
  approved: number;
  needsAdjustment: number;
  byStatus: Record<Status, number>;
};
export function reviewPatchIsSaved(current: Job | null | undefined, previous: Job, action: ReviewAction, notes: string): boolean;
