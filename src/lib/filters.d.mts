export interface MaterialOption {
  value: string;
  label: string;
}
export interface FilterableJob {
  job_kind?: "mat" | "dehumidifier";
  review_status?: "pending" | "approved" | "needs_adjustment";
  status: string;
  store_name: string;
  address?: string;
  material?: string | null;
  thickness_mm?: number | null;
  responsible_name?: string | null;
}
export interface JobFilters {
  job_kind?: "all" | "mat" | "dehumidifier";
  review_status?: "all" | "pending" | "approved" | "needs_adjustment";
  review?: "all" | "pending" | "approved" | "needs_adjustment";
  status: string;
  material: string;
  thickness: "all" | "17" | "20" | "unknown";
  search: string;
  responsible?: string;
}
export function materialKey(material: string | null | undefined): string;
export function getMaterialOptions(
  jobs: readonly Pick<FilterableJob, "material">[],
  baseOptions: readonly MaterialOption[],
): MaterialOption[];
export function responsibleKey(name: string | null | undefined): string;
export function getResponsibleOptions(
  jobs: readonly Pick<FilterableJob, "responsible_name">[],
  profiles: readonly { display_name: string; active: boolean }[],
): MaterialOption[];
export function matchesJob(job: FilterableJob, filters: JobFilters): boolean;
export function sortJobsForWorkspace<T extends Pick<FilterableJob, "status">>(jobs: readonly T[]): T[];
