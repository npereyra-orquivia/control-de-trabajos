import type { Job } from "../types";
export type PreparedNotes = { notes: string; archive: string; original: string };
export function prepareJobNotes(job?: Pick<Job, "notes" | "thickness_mm"> | null): PreparedNotes;
export function combineJobNotes(notes: string, prepared: PreparedNotes): string;
export function editableNotesLimit(prepared: PreparedNotes): number;
