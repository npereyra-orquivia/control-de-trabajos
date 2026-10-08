import type { Job, JobKind } from "../types";
import type { jsPDF } from "jspdf";
export interface ReportRow {
  id: string; name: string; status: string; dimensions: string; quantity: number;
  cut: string; installed: string; photos: string[];
}
export function reportRows(jobs: Job[], kind: JobKind): ReportRow[];
export function createReportDocument(rows: ReportRow[], kind: JobKind, options?: { logo?: string; images?: Map<string, string>; createdAt?: Date }): jsPDF;
export function exportReport(jobs: Job[], kind: JobKind, resolvePhotoUrls: (paths: string[]) => Promise<Record<string, string>>, baseUrl: string): Promise<void>;
