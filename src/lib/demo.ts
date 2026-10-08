import type { Job, JobEvent, JobLock, JobPatch, JobInput, Profile, ReviewAction } from "../types";
import { nextStatus, validateInput } from "./validation.mjs";
import { jobPhotoPaths } from "./photos.mjs";
import { jobKind } from "./workflow.mjs";
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
const eventKey = key + "-events";
function sampleJobs(): Job[] {
  const now = new Date().toISOString();
  return [
    {
      store_name: "Tienda Centro",
      address: "Calle Mayor, 24 · Barcelona",
      width_cm: 120,
      length_cm: 180,
      material: "coco",
      responsible_name: "Ana García",
      thickness_mm: 20,
      notes: "Entrada principal. Comprobar el sentido de la fibra.",
      status: "measured" as const,
      job_kind: "mat" as const,
      quantity: 1,
      created_by: "demo-ana",
    },
    {
      store_name: "Local Rambla",
      address: "Rambla, 108 · Barcelona",
      width_cm: 95,
      length_cm: 150,
      material: "coco",
      responsible_name: "Luis Martín",
      thickness_mm: 17,
      notes: "Dejar preparado para la ruta de mañana.",
      status: "measured" as const,
      job_kind: "mat" as const,
      quantity: 1,
      created_by: "demo-luis",
    },
    {
      store_name: "Tienda Norte",
      address: "Avenida del Norte, 12 · Barcelona",
      width_cm: 200,
      length_cm: 140,
      material: "metálico",
      responsible_name: "Marta López",
      thickness_mm: null,
      notes: "Acceso por la puerta lateral.",
      status: "cut" as const,
      job_kind: "mat" as const,
      quantity: 1,
      created_by: "demo-marta",
    },
    {
      store_name: "Tienda Centro",
      address: "",
      width_cm: null,
      length_cm: null,
      material: "",
      responsible_name: "Ana García",
      thickness_mm: null,
      notes: "Colocar los aparatos y fotografiar el trabajo terminado.",
      status: "pending_installation" as const,
      job_kind: "dehumidifier" as const,
      quantity: 4,
      created_by: "demo-ana",
    },
    {
      store_name: "Local Rambla",
      address: "",
      width_cm: null,
      length_cm: null,
      material: "",
      responsible_name: "Luis Martín",
      thickness_mm: null,
      notes: "",
      status: "pending_installation" as const,
      job_kind: "dehumidifier" as const,
      quantity: 3,
      created_by: "demo-luis",
    },
    {
      store_name: "Tienda Norte",
      address: "",
      width_cm: null,
      length_cm: null,
      material: "",
      responsible_name: "Marta López",
      thickness_mm: null,
      notes: "",
      status: "pending_installation" as const,
      job_kind: "dehumidifier" as const,
      quantity: 3,
      created_by: "demo-marta",
    },
  ].map((job, index) => ({
    ...job,
    id: `demo-job-${index}`,
    photo_path: null,
    photo_paths: [],
    measured_at: job.job_kind === "mat" ? now : null,
    measured_by: job.job_kind === "mat" ? job.created_by : null,
    cutting_at: null,
    cutting_by: null,
    cut_at: job.status === "cut" ? now : null,
    cut_by: job.status === "cut" ? job.created_by : null,
    installed_at: null,
    created_at: now,
    updated_at: now,
    updated_by: job.created_by,
    version: 1,
    review_status: "pending",
    rework_kind: null,
    revision_no: 0,
    review_notes: "",
    reviewed_at: null,
    reviewed_by: null,
  }));
}
export function demoJobs(): Job[] {
  try {
    const value = localStorage.getItem(key);
    if (value) {
      const storedJobs: Job[] = JSON.parse(value);
      if (Array.isArray(storedJobs))
        return storedJobs.map((job) => ({
          ...job,
          job_kind: jobKind(job),
          status: String(job.status) === "cutting" ? "measured" : job.status,
          thickness_mm: job.thickness_mm ?? null,
          responsible_name: job.responsible_name ?? "",
          photo_paths: jobPhotoPaths(job),
          review_status: job.review_status ?? "pending",
          rework_kind: job.rework_kind ?? null,
          revision_no: job.revision_no ?? 0,
          review_notes: job.review_notes ?? "",
          reviewed_at: job.reviewed_at ?? null,
          reviewed_by: job.reviewed_by ?? null,
        }));
    }
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
  const validated = validateInput(input);
  const status = validated.status ?? "measured";
  if (validated.job_kind === "dehumidifier" ? status !== "pending_installation" :
    !["pending_measurement", "measured"].includes(status))
    throw new Error("Registra el trabajo en su fase inicial y completa los pasos después.");
  const job: Job = {
    ...validated,
    job_kind: validated.job_kind ?? "mat",
    responsible_name: validated.responsible_name ?? "",
    id,
    status,
    photo_path: null,
    photo_paths: [],
    measured_at: status === "measured" ? now : null,
    measured_by: status === "measured" ? demoProfile.id : null,
    cutting_at: null,
    cut_at: null,
    installed_at: null,
    created_at: now,
    updated_at: now,
    created_by: demoProfile.id,
    updated_by: demoProfile.id,
    version: 1,
    review_status: "pending",
    rework_kind: null,
    revision_no: 0,
    review_notes: "",
    reviewed_at: null,
    reviewed_by: null,
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
  const { jobs, old } = editableDemo(id, token, version);
  if (patch.job_kind !== undefined && patch.job_kind !== old.job_kind)
    throw new Error("El tipo de trabajo no puede cambiarse.");
  if (patch.status && patch.status !== old.status && patch.status !== nextStatus(old.status, old.job_kind))
    throw new Error("Sigue el orden de las fases del trabajo.");
  if (old.job_kind === "dehumidifier" && old.status === "installed" &&
    patch.quantity !== undefined && patch.quantity !== old.quantity)
    throw new Error("La cantidad de un trabajo colocado no puede cambiarse.");
  const validated = validateInput({ ...old, ...patch }, patch.status ?? old.status);
  const measurementChanged = (["width_cm", "length_cm", "quantity", "thickness_mm", "material"] as const)
    .some((field) => validated[field] !== old[field]);
  if (old.job_kind === "mat" && measurementChanged &&
    !["pending_measurement", "measured"].includes(validated.status ?? old.status) &&
    !(old.status === "measured" && validated.status === "cut"))
    throw new Error("Vuelve a medir el trabajo antes de cambiar medidas, espesor o material.");
  const photoPaths = patch.photo_paths !== undefined
    ? [...new Set(patch.photo_paths)]
    : patch.photo_path !== undefined
      ? patch.photo_path ? [patch.photo_path, ...jobPhotoPaths(old).slice(1)] : jobPhotoPaths(old).slice(1)
      : jobPhotoPaths(old);
  if ((patch.status || old.status) === "installed" && !photoPaths.length)
    throw new Error("Añade al menos una foto antes de marcar Colocado.");
  const previousPhotos = new Set(demoEvents(id)
    .filter((event) => event.event_type === "rework_started")
    .flatMap((event) => jobPhotoPaths({
      photo_path: event.snapshot.photo_path ?? null,
      photo_paths: event.snapshot.photo_paths,
    })));
  if (photoPaths.some((path) => previousPhotos.has(path)))
    throw new Error("Añade fotos nuevas de la corrección. Las anteriores están en el historial.");
  const now = new Date().toISOString();
  const job = {
    ...old,
    ...validated,
    status: patch.status ?? old.status,
    job_kind: old.job_kind,
    photo_paths: photoPaths,
    photo_path: photoPaths[0] || null,
    updated_at: now,
    updated_by: demoProfile.id,
    version: old.version + 1,
  };
  if ((patch.status === "measured" && old.status !== "measured") ||
    (old.job_kind === "mat" && measurementChanged && job.status !== "pending_measurement")) {
    job.measured_at = now;
    job.measured_by = demoProfile.id;
  }
  if (patch.status === "cut") {
    job.cut_at = now;
    job.cut_by = demoProfile.id;
  }
  if (patch.status === "installed" && old.status !== "installed") {
    job.installed_at = now;
    job.installed_by = demoProfile.id;
    job.review_status = "pending";
    job.reviewed_at = null;
    job.reviewed_by = null;
  }
  save(jobs.map((item) => (item.id === id ? job : item)));
  return job;
}

function editableDemo(id: string, token: string, version: number) {
  const lock = rawLocks().find((item) => item.job_id === id && item.token === token &&
    Date.parse(item.expires_at) > Date.now());
  if (!lock) throw new Error("El bloqueo ha caducado. Cierra y vuelve a abrir el trabajo.");
  const jobs = demoJobs();
  const old = jobs.find((job) => job.id === id);
  if (!old || old.version !== version)
    throw new Error("El trabajo ha cambiado. Cierra y vuelve a abrirlo para ver la última información.");
  return { jobs, old };
}

function rawEvents(): JobEvent[] {
  try {
    const events = JSON.parse(localStorage.getItem(eventKey) || "[]");
    return Array.isArray(events) ? events : [];
  } catch { return []; }
}

export function demoEvents(id: string): JobEvent[] {
  return rawEvents().filter((event) => event.job_id === id).reverse();
}

export function reviewDemo(id: string, token: string, version: number, action: ReviewAction, notes = ""): Job {
  const { jobs, old } = editableDemo(id, token, version);
  if (old.job_kind !== "mat" || old.status !== "installed")
    throw new Error("La revisión corresponde a un felpudo colocado.");
  if (!["approve", "trim", "add", "replace"].includes(action))
    throw new Error("Selecciona el resultado de la revisión.");
  if (typeof notes !== "string" || notes.trim().length > 3000)
    throw new Error("Las indicaciones deben tener como máximo 3.000 caracteres.");
  if (action !== "approve" && !notes.trim())
    throw new Error("Explica qué necesita corregirse.");
  const now = new Date().toISOString();
  const job: Job = {
    ...old,
    review_status: action === "approve" ? "approved" : "needs_adjustment",
    review_notes: notes.trim(),
    reviewed_at: now,
    reviewed_by: demoProfile.id,
    updated_at: now,
    updated_by: demoProfile.id,
    version: old.version + 1,
  };
  if (action !== "approve") {
    job.revision_no += 1;
    job.rework_kind = action;
    job.status = action === "trim" ? "pending_adjustment" : "pending_measurement";
    job.photo_path = null;
    job.photo_paths = [];
    job.installed_at = null;
    job.installed_by = null;
    job.cut_at = null;
    job.cut_by = null;
    job.cutting_at = null;
    job.cutting_by = null;
    if (action !== "trim") {
      job.width_cm = null;
      job.length_cm = null;
      job.measured_at = null;
      job.measured_by = null;
    }
  }
  const events = rawEvents();
  const event: JobEvent = {
    id: crypto.randomUUID(),
    job_id: id,
    revision_no: job.revision_no,
    event_type: action === "approve" ? "review_approved" : "rework_started",
    notes: notes.trim(),
    actor_id: demoProfile.id,
    created_at: now,
    snapshot: structuredClone(old),
  };
  localStorage.setItem(eventKey, JSON.stringify([...events, event]));
  try { save(jobs.map((item) => item.id === id ? job : item)); }
  catch (error) {
    localStorage.setItem(eventKey, JSON.stringify(events));
    throw error;
  }
  return job;
}
