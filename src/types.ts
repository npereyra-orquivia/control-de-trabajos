import { ALL_STATUSES } from "./lib/workflow.mjs";

export type JobKind = "mat" | "dehumidifier";
export type Status =
  | "pending_measurement"
  | "measured"
  | "cut"
  | "installed"
  | "pending_installation"
  | "pending_adjustment";
export type ReviewStatus = "pending" | "approved" | "needs_adjustment";
export type ReworkKind = "trim" | "add" | "replace";
export type ReviewAction = "approve" | ReworkKind;
export interface StatusDefinition {
  id: Status;
  label: string;
  short: string;
  action: string;
}
export interface Profile {
  id: string;
  display_name: string;
  role: "admin" | "member";
  active: boolean;
}
export interface Job {
  id: string;
  job_kind: JobKind;
  store_name: string;
  address: string;
  width_cm: number | null;
  length_cm: number | null;
  thickness_mm: number | null;
  quantity: number;
  material: string;
  responsible_name: string;
  notes: string;
  status: Status;
  photo_path: string | null;
  photo_paths?: string[];
  measured_at: string | null;
  cutting_at: string | null;
  cut_at: string | null;
  installed_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  version: number;
  measured_by?: string | null;
  cutting_by?: string | null;
  cut_by?: string | null;
  installed_by?: string | null;
  review_status: ReviewStatus;
  rework_kind: ReworkKind | null;
  revision_no: number;
  review_notes: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
}
export interface JobEvent {
  id: string;
  job_id: string;
  revision_no: number;
  event_type: "review_approved" | "rework_started";
  notes: string;
  actor_id: string;
  created_at: string;
  snapshot: Partial<Job>;
}
export interface JobLock {
  job_id: string;
  user_id: string;
  expires_at: string;
}
export type JobInput = Pick<
  Job,
  | "store_name"
  | "address"
  | "width_cm"
  | "length_cm"
  | "thickness_mm"
  | "quantity"
  | "material"
  | "responsible_name"
  | "notes"
> & { job_kind?: JobKind; status?: Status };
export type JobPatch = Partial<JobInput & Pick<Job, "status" | "photo_path" | "photo_paths">>;
export const MATERIALS = [
  { value: "coco", label: "Coco" },
  { value: "metálico", label: "Metálico" },
  { value: "no hay", label: "No hay" },
] as const;
export const STATUSES: StatusDefinition[] = ALL_STATUSES;
