import { jobPhotoPaths } from "./photos.mjs";

export const ALL_STATUSES = [
  { id: "pending_measurement", label: "Por medir", short: "Por medir", action: "Marcar medido" },
  { id: "measured", label: "Medido", short: "Medido", action: "Marcar cortado" },
  { id: "cut", label: "Cortado", short: "Cortado", action: "Marcar colocado" },
  { id: "installed", label: "Colocado", short: "Colocado", action: "Ver trabajo" },
  { id: "pending_installation", label: "Pendiente de colocar", short: "Por colocar", action: "Marcar colocado" },
  { id: "pending_adjustment", label: "Por ajustar", short: "Por ajustar", action: "Marcar colocado" },
];

export function jobKind(jobOrKind) {
  const kind = typeof jobOrKind === "string" ? jobOrKind : jobOrKind?.job_kind;
  return kind === "dehumidifier" ? "dehumidifier" : "mat";
}

export function statusLabel(status) {
  return ALL_STATUSES.find((stage) => stage.id === status)?.label ?? status;
}

export function getJobStages(jobOrKind) {
  let ids;
  if (jobKind(jobOrKind) === "dehumidifier") {
    ids = ["pending_installation", "installed"];
  } else if (typeof jobOrKind === "object" && jobOrKind !== null &&
    (jobOrKind.status === "pending_adjustment" || jobOrKind.rework_kind === "trim")) {
    ids = ["pending_adjustment", "installed"];
  } else if (typeof jobOrKind === "object" && jobOrKind !== null &&
    (jobOrKind.status === "pending_measurement" || ["add", "replace"].includes(jobOrKind.rework_kind))) {
    ids = ["pending_measurement", "measured", "cut", "installed"];
  } else {
    ids = ["measured", "cut", "installed"];
  }
  return ids.map((id) => ALL_STATUSES.find((stage) => stage.id === id));
}

export function getJobMetrics(jobs, kind) {
  const selected = kind ? jobs.filter((job) => jobKind(job) === kind) : jobs;
  const byStatus = Object.fromEntries(ALL_STATUSES.map(({ id }) => [id, 0]));
  let completed = 0, totalUnits = 0, completedUnits = 0;
  let pendingReview = 0, approved = 0, needsAdjustment = 0;
  for (const job of selected) {
    if (Object.hasOwn(byStatus, job.status)) byStatus[job.status] += 1;
    const units = jobKind(job) === "dehumidifier" ? job.quantity : 1;
    totalUnits += units;
    if (job.status === "installed") {
      completed += 1;
      completedUnits += units;
      if (jobKind(job) === "mat") {
        if ((job.review_status ?? "pending") === "pending") pendingReview += 1;
        if (job.review_status === "approved") approved += 1;
      }
    }
    if (jobKind(job) === "mat" && job.review_status === "needs_adjustment") needsAdjustment += 1;
  }
  return {
    total: selected.length, completed, pending: selected.length - completed,
    totalUnits, completedUnits, pendingUnits: totalUnits - completedUnits,
    pendingReview, approved, needsAdjustment, byStatus,
  };
}

// A lost response is only success when the exact requested review was saved.
// The editing lease plus the next version prevents a later edit from being
// mistaken for the result of this request.
export function reviewPatchIsSaved(current, previous, action, notes) {
  if (!current || !previous || current.id !== previous.id ||
    current.version !== previous.version + 1 ||
    jobKind(current) !== "mat" || jobKind(previous) !== "mat" ||
    previous.status !== "installed" || !["approve", "trim", "add", "replace"].includes(action) ||
    typeof notes !== "string" || current.review_notes !== notes.trim()) return false;
  if (!current.reviewed_at || current.reviewed_at === previous.reviewed_at ||
    !Number.isFinite(Date.parse(current.reviewed_at)) ||
    !current.reviewed_by || current.reviewed_by !== current.updated_by) return false;
  const unchanged = ["store_name", "address", "thickness_mm", "quantity", "material",
    "responsible_name", "notes", "created_at", "created_by"];
  if (unchanged.some((field) => current[field] !== previous[field])) return false;

  const oldRevision = previous.revision_no ?? 0;
  if (action === "approve") {
    if (current.status !== "installed" || current.review_status !== "approved" ||
      current.revision_no !== oldRevision || current.rework_kind !== previous.rework_kind)
      return false;
    const preserved = ["width_cm", "length_cm", "measured_at", "measured_by", "cutting_at",
      "cutting_by", "cut_at", "cut_by", "installed_at", "installed_by"];
    if (preserved.some((field) => current[field] !== previous[field])) return false;
    const before = jobPhotoPaths(previous), after = jobPhotoPaths(current);
    return after.length === before.length && after.every((path, index) => path === before[index]);
  }
  if (current.revision_no !== oldRevision + 1 || current.review_status !== "needs_adjustment" ||
    current.rework_kind !== action || jobPhotoPaths(current).length || current.photo_path != null ||
    current.installed_at != null || current.installed_by != null || current.cut_at != null ||
    current.cut_by != null || current.cutting_at != null || current.cutting_by != null)
    return false;
  if (action === "trim") {
    return current.status === "pending_adjustment" &&
      ["width_cm", "length_cm", "measured_at", "measured_by"]
        .every((field) => current[field] === previous[field]);
  }
  return current.status === "pending_measurement" && current.width_cm == null &&
    current.length_cm == null && current.measured_at == null && current.measured_by == null;
}
