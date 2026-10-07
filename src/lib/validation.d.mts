import type { JobInput, Status } from "../types";
export function parseMeasure(value: string | number): number;
export function validateInput(
  input: Omit<JobInput, "thickness_mm" | "responsible_name"> & { thickness_mm?: number | null; responsible_name?: string },
): JobInput;
export function validatePhoto(file: File): void;
export function nextStatus(status: Status): Status | null;
