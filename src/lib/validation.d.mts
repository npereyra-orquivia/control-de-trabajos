import type { JobInput, Status } from "../types";
export function parseMeasure(value: string | number): number;
export function validateInput(input: JobInput): JobInput;
export function validatePhoto(file: File): void;
export function nextStatus(status: Status): Status | null;
