import type { JobInput, Status } from "../types";
export function parseMeasure(value: string | number): number;
export function validateInput(
  input: Omit<JobInput, "thickness_mm"> & { thickness_mm?: number | null },
): JobInput;
export function validatePhoto(file: File): void;
export function nextStatus(status: Status): Status | null;
