export type Status = "measured" | "cutting" | "cut" | "installed";
export interface Profile {
  id: string;
  display_name: string;
  role: "admin" | "member";
  active: boolean;
}
export interface Job {
  id: string;
  store_name: string;
  address: string;
  width_cm: number;
  length_cm: number;
  quantity: number;
  material: string;
  notes: string;
  status: Status;
  photo_path: string | null;
  measured_at: string;
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
  | "quantity"
  | "material"
  | "notes"
>;
export type JobPatch = Partial<JobInput & Pick<Job, "status" | "photo_path">>;
export const STATUSES: {
  id: Status;
  label: string;
  short: string;
  action: string;
}[] = [
  {
    id: "measured",
    label: "Por cortar",
    short: "Por cortar",
    action: "Empezar corte",
  },
  {
    id: "cutting",
    label: "En corte",
    short: "En corte",
    action: "Marcar cortado",
  },
  {
    id: "cut",
    label: "Por colocar",
    short: "Por colocar",
    action: "Colocar y hacer foto",
  },
  {
    id: "installed",
    label: "Terminado",
    short: "Terminados",
    action: "Ver trabajo",
  },
];
