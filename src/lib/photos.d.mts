import type { Job, JobPatch } from "../types";
export function jobPhotoPaths(job: Pick<Job, "photo_path" | "photo_paths"> | null | undefined): string[];
export function appendPhotoPaths(job: Pick<Job, "photo_path" | "photo_paths"> | null | undefined, addedPaths: readonly string[]): string[];
export function photoPatchIsSaved(job: Job | null | undefined, patch: JobPatch, expectedVersion: number): boolean;
