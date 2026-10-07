export interface MaterialOption {
  value: string;
  label: string;
}
export interface FilterableJob {
  status: string;
  store_name: string;
  address?: string;
  material?: string | null;
  thickness_mm?: number | null;
}
export interface JobFilters {
  status: string;
  material: string;
  thickness: "all" | "17" | "20" | "unknown";
  search: string;
}
export function materialKey(material: string | null | undefined): string;
export function getMaterialOptions(
  jobs: readonly Pick<FilterableJob, "material">[],
  baseOptions: readonly MaterialOption[],
): MaterialOption[];
export function matchesJob(job: FilterableJob, filters: JobFilters): boolean;
