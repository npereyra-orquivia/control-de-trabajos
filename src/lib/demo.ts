import type { Job, JobLock, JobPatch, JobInput, Profile } from "../types";
export const demoProfile: Profile = {
  id: "demo-ana",
  display_name: "Ana García",
  role: "admin",
  active: true,
};
export const demoProfiles: Profile[] = [
  demoProfile,
  {
    id: "demo-luis",
    display_name: "Luis Martín",
    role: "member",
    active: true,
  },
  {
    id: "demo-marta",
    display_name: "Marta López",
    role: "member",
    active: true,
  },
];
const key = "control-trabajos-demo-v1";
const lockKey = key + "-locks";
function sampleJobs(): Job[] {
  const now = new Date().toISOString();
  return [
    {
      store_name: "Tienda Centro",
      address: "Calle Mayor, 24 · Barcelona",
      width_cm: 120,
      length_cm: 180,
      material: "Coco natural · 20 mm",
      notes: "Entrada principal. Comprobar el sentido de la fibra.",
      status: "measured" as const,
      created_by: "demo-ana",
    },
    {
      store_name: "Local Rambla",
      address: "Rambla, 108 · Barcelona",
      width_cm: 95,
      length_cm: 150,
      material: "Coco natural · 20 mm",
      notes: "Dejar preparado para la ruta de mañana.",
      status: "cutting" as const,
      created_by: "demo-luis",
    },
    {
      store_name: "Tienda Norte",
      address: "Avenida del Norte, 12 · Barcelona",
      width_cm: 200,
      length_cm: 140,
      material: "Sintético gris · 12 mm",
      notes: "Acceso por la puerta lateral.",
      status: "cut" as const,
      created_by: "demo-marta",
    },
  ].map((job, index) => ({
    ...job,
    id: `demo-job-${index}`,
    quantity: 1,
    photo_path: null,
    measured_at: now,
    measured_by: job.created_by,
    cutting_at: index > 0 ? now : null,
    cutting_by: index > 0 ? job.created_by : null,
    cut_at: index > 1 ? now : null,
    cut_by: index > 1 ? job.created_by : null,
    installed_at: null,
    created_at: now,
    updated_at: now,
    updated_by: job.created_by,
    version: 1,
  }));
}
export function demoJobs(): Job[] {
  try {
    const value = localStorage.getItem(key);
    if (value) return JSON.parse(value);
  } catch {
    /* A fresh example remains usable if storage is unavailable. */
  }
  const jobs = sampleJobs();
  save(jobs);
  return jobs;
}
function save(jobs: Job[]) {
  localStorage.setItem(key, JSON.stringify(jobs));
}
type DemoLock = JobLock & { token: string };
function rawLocks(): DemoLock[] {
  try {
    return JSON.parse(localStorage.getItem(lockKey) || "[]");
  } catch {
    return [];
  }
}
export function demoLocks(): JobLock[] {
  return rawLocks().filter((lock) => Date.parse(lock.expires_at) > Date.now());
}
export function acquireDemo(id: string, token: string) {
  const locks = rawLocks().filter(
    (lock) => Date.parse(lock.expires_at) > Date.now(),
  );
  if (locks.some((lock) => lock.job_id === id && lock.token !== token))
    return false;
  const renewed = {
    job_id: id,
    user_id: demoProfile.id,
    token,
    expires_at: new Date(Date.now() + 180000).toISOString(),
  };
  localStorage.setItem(
    lockKey,
    JSON.stringify([...locks.filter((lock) => lock.job_id !== id), renewed]),
  );
  return true;
}
export function releaseDemo(id: string, token: string) {
  localStorage.setItem(
    lockKey,
    JSON.stringify(
      rawLocks().filter((lock) => lock.job_id !== id || lock.token !== token),
    ),
  );
}
export function createDemo(input: JobInput, id: string = crypto.randomUUID()) {
  const existing = demoJobs().find((job) => job.id === id);
  if (existing) return existing;
  const now = new Date().toISOString();
  const job: Job = {
    ...input,
    id,
    status: "measured",
    photo_path: null,
    measured_at: now,
    measured_by: demoProfile.id,
    cutting_at: null,
    cut_at: null,
    installed_at: null,
    created_at: now,
    updated_at: now,
    created_by: demoProfile.id,
    updated_by: demoProfile.id,
    version: 1,
  };
  save([job, ...demoJobs()]);
  return job;
}
export function updateDemo(
  id: string,
  token: string,
  version: number,
  patch: JobPatch,
) {
  const lock = rawLocks().find(
    (lock) =>
      lock.job_id === id &&
      lock.token === token &&
      Date.parse(lock.expires_at) > Date.now(),
  );
  if (!lock)
    throw new Error(
      "El bloqueo ha caducado. Cierra y vuelve a abrir el trabajo.",
    );
  const jobs = demoJobs();
  const old = jobs.find((job) => job.id === id);
  if (!old || old.version !== version)
    throw new Error(
      "El trabajo ha cambiado. Cierra y vuelve a abrirlo para ver la última información.",
    );
  if (patch.status === "installed" && !patch.photo_path)
    throw new Error("Añade una foto antes de terminar.");
  const now = new Date().toISOString();
  const job = {
    ...old,
    ...patch,
    updated_at: now,
    updated_by: demoProfile.id,
    version: old.version + 1,
  };
  if (patch.status === "cutting") {
    job.cutting_at = now;
    job.cutting_by = demoProfile.id;
  }
  if (patch.status === "cut") {
    job.cut_at = now;
    job.cut_by = demoProfile.id;
  }
  if (patch.status === "installed") {
    job.installed_at = now;
    job.installed_by = demoProfile.id;
  }
  save(jobs.map((item) => (item.id === id ? job : item)));
  return job;
}
