import test from "node:test";
import assert from "node:assert/strict";
import { getJobStages, getJobMetrics, jobKind, statusLabel, reviewPatchIsSaved } from "../src/lib/workflow.mjs";
import { acquireDemo, createDemo, demoJobs, demoEvents, reviewDemo, updateDemo } from "../src/lib/demo.ts";

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  clear() { this.values.clear(); }
}
Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });

const matInput = {
  job_kind: "mat", store_name: "Zegna", address: "", width_cm: 82.5, length_cm: 182.5,
  thickness_mm: null, quantity: 1, material: "coco", responsible_name: "Nicole", notes: "",
};
const stages = (job) => getJobStages(job).map((stage) => stage.id);
function installedMat() {
  const initial = createDemo(matInput);
  acquireDemo(initial.id, "owner");
  const cut = updateDemo(initial.id, "owner", initial.version, { status: "cut" });
  return updateDemo(initial.id, "owner", cut.version, { status: "installed", photo_paths: ["original.jpg"] });
}

test("each kind and correction has its own visible phases", () => {
  assert.equal(jobKind({}), "mat");
  assert.equal(jobKind("dehumidifier"), "dehumidifier");
  assert.deepEqual(stages("mat"), ["measured", "cut", "installed"]);
  assert.deepEqual(stages("dehumidifier"), ["pending_installation", "installed"]);
  assert.deepEqual(stages({ job_kind: "mat", status: "pending_measurement" }), ["pending_measurement", "measured", "cut", "installed"]);
  assert.deepEqual(stages({ job_kind: "mat", status: "installed", rework_kind: "replace" }), ["pending_measurement", "measured", "cut", "installed"]);
  assert.deepEqual(stages({ job_kind: "mat", status: "pending_adjustment", rework_kind: "trim" }), ["pending_adjustment", "installed"]);
  assert.equal(statusLabel("pending_measurement"), "Por medir");
  assert.equal(statusLabel("pending_installation"), "Pendiente de colocar");
});

test("metrics distinguish store jobs from appliance units and pending inspections", () => {
  const jobs = [
    { status: "installed", review_status: "pending", quantity: 1 },
    { job_kind: "mat", status: "installed", review_status: "approved", quantity: 1 },
    { job_kind: "mat", status: "pending_adjustment", review_status: "needs_adjustment", quantity: 1 },
    { job_kind: "dehumidifier", status: "installed", quantity: 3 },
    { job_kind: "dehumidifier", status: "pending_installation", quantity: 7 },
  ];
  assert.deepEqual(getJobMetrics(jobs, "dehumidifier"), {
    total: 2, completed: 1, pending: 1, totalUnits: 10, completedUnits: 3, pendingUnits: 7,
    pendingReview: 0, approved: 0, needsAdjustment: 0,
    byStatus: { pending_measurement: 0, measured: 0, cut: 0, installed: 1, pending_installation: 1, pending_adjustment: 0 },
  });
  const mats = getJobMetrics(jobs, "mat");
  assert.equal(mats.total, 3);
  assert.equal(mats.pendingReview, 1);
  assert.equal(mats.approved, 1);
  assert.equal(mats.needsAdjustment, 1);
});

test("approval retains installation evidence and records its immutable snapshot", () => {
  localStorage.clear();
  const installed = installedMat();
  assert.throws(() => reviewDemo(installed.id, "wrong", installed.version, "approve"), /bloqueo/);
  assert.throws(() => reviewDemo(installed.id, "owner", installed.version - 1, "approve"), /cambiado/);
  const approved = reviewDemo(installed.id, "owner", installed.version, "approve", "Correctamente colocado");
  assert.equal(approved.status, "installed");
  assert.equal(approved.review_status, "approved");
  assert.deepEqual(approved.photo_paths, installed.photo_paths);
  assert.equal(approved.installed_at, installed.installed_at);
  assert.equal(approved.revision_no, 0);
  const event = demoEvents(installed.id)[0];
  assert.equal(event.event_type, "review_approved");
  assert.deepEqual(event.snapshot, installed);
  approved.photo_paths.push("changed-locally.jpg");
  assert.deepEqual(demoEvents(installed.id)[0].snapshot.photo_paths, ["original.jpg"]);
});

test("trimming reopens only adjustment, preserving measurements and requiring new final photos", () => {
  localStorage.clear();
  const installed = installedMat();
  assert.throws(() => reviewDemo(installed.id, "owner", installed.version, "trim", " "), /corregirse/);
  const reopened = reviewDemo(installed.id, "owner", installed.version, "trim", "Recortar el sobrante derecho");
  assert.equal(reopened.status, "pending_adjustment");
  assert.equal(reopened.review_status, "needs_adjustment");
  assert.equal(reopened.rework_kind, "trim");
  assert.equal(reopened.revision_no, 1);
  assert.equal(reopened.width_cm, installed.width_cm);
  assert.equal(reopened.measured_at, installed.measured_at);
  assert.equal(reopened.cut_at, null);
  assert.equal(reopened.installed_at, null);
  assert.deepEqual(reopened.photo_paths, []);
  assert.equal(demoEvents(installed.id)[0].snapshot.revision_no, 0);
  assert.equal(demoEvents(installed.id)[0].revision_no, 1);
  assert.throws(() => updateDemo(reopened.id, "owner", reopened.version, { status: "installed" }), /foto/);
  assert.throws(() => updateDemo(reopened.id, "owner", reopened.version, { status: "installed", photo_paths: ["original.jpg"] }), /nuevas/);
  const corrected = updateDemo(reopened.id, "owner", reopened.version, { status: "installed", photo_paths: ["trimmed.jpg", "trimmed-detail.jpg"] });
  assert.equal(corrected.review_status, "pending");
  assert.equal(corrected.reviewed_at, null);
  assert.equal(corrected.reviewed_by, null);
  assert.equal(corrected.review_notes, "Recortar el sobrante derecho");
  assert.equal(corrected.rework_kind, "trim");
});

test("replacement and additions restart measuring without losing the original history", () => {
  for (const action of ["replace", "add"]) {
    localStorage.clear();
    const installed = installedMat();
    const reopened = reviewDemo(installed.id, "owner", installed.version, action, "Volver a medir y preparar una pieza nueva");
    assert.equal(reopened.status, "pending_measurement");
    assert.equal(reopened.width_cm, null);
    assert.equal(reopened.length_cm, null);
    assert.equal(reopened.measured_at, null);
    assert.equal(reopened.cut_at, null);
    assert.equal(demoEvents(installed.id)[0].snapshot.width_cm, installed.width_cm);
    assert.deepEqual(demoEvents(installed.id)[0].snapshot.photo_paths, ["original.jpg"]);
    assert.throws(() => updateDemo(reopened.id, "owner", reopened.version, { status: "measured" }), /medidas/);
    assert.throws(() => updateDemo(reopened.id, "owner", reopened.version, { status: "cut", width_cm: 90, length_cm: 180 }), /orden/);
    const measured = updateDemo(reopened.id, "owner", reopened.version, { status: "measured", width_cm: 90, length_cm: 180 });
    const cut = updateDemo(measured.id, "owner", measured.version, { status: "cut" });
    const corrected = updateDemo(cut.id, "owner", cut.version, { status: "installed", photo_paths: ["new-piece.jpg"] });
    assert.equal(corrected.review_status, "pending");
    assert.equal(corrected.revision_no, 1);
    const secondCorrection = reviewDemo(corrected.id, "owner", corrected.version, "trim", "Ajustar borde");
    assert.equal(secondCorrection.revision_no, 2);
    assert.throws(() => updateDemo(secondCorrection.id, "owner", secondCorrection.version, { photo_paths: ["original.jpg"] }), /nuevas/);
    assert.throws(() => updateDemo(secondCorrection.id, "owner", secondCorrection.version, { photo_paths: ["new-piece.jpg"] }), /nuevas/);
    assert.equal(demoEvents(installed.id).length, 2);
  }
});

test("appliance demo has ten units and requires a picture before installation", () => {
  localStorage.clear();
  assert.equal(getJobMetrics(demoJobs(), "dehumidifier").totalUnits, 10);
  const device = createDemo({ ...matInput, job_kind: "dehumidifier", quantity: 4 });
  assert.equal(device.status, "pending_installation");
  assert.equal(device.measured_at, null);
  assert.equal(device.width_cm, null);
  acquireDemo(device.id, "owner");
  assert.throws(() => updateDemo(device.id, "owner", device.version, { status: "installed" }), /foto/);
  const changed = updateDemo(device.id, "owner", device.version, { quantity: 5 });
  const installed = updateDemo(device.id, "owner", changed.version, { status: "installed", photo_paths: ["devices.jpg"] });
  assert.equal(installed.quantity, 5);
  assert.throws(() => updateDemo(installed.id, "owner", installed.version, { quantity: 6 }), /cantidad/);
  assert.throws(() => reviewDemo(installed.id, "owner", installed.version, "approve"), /felpudo/);
});

test("demo creation and fixed cut dimensions enforce the same phase restrictions as the server", () => {
  localStorage.clear();
  for (const status of ["cut", "installed", "pending_adjustment"])
    assert.throws(() => createDemo({ ...matInput, status }), /fase inicial/);
  assert.throws(() => createDemo({ ...matInput, job_kind: "dehumidifier", status: "installed", quantity: 2 }), /fase inicial/);
  const initial = createDemo({ ...matInput, responsible_name: "  Nicole  " });
  assert.equal(initial.responsible_name, "Nicole");
  acquireDemo(initial.id, "owner");
  const cut = updateDemo(initial.id, "owner", initial.version, { status: "cut" });
  assert.throws(() => updateDemo(cut.id, "owner", cut.version, { width_cm: 100 }), /Vuelve a medir/);
  assert.throws(() => updateDemo(cut.id, "owner", cut.version, { material: "metálico" }), /Vuelve a medir/);
});

test("a lost review response is confirmed only for the requested action and exact next version", () => {
  for (const action of ["approve", "trim", "add", "replace"]) {
    localStorage.clear();
    const old = installedMat();
    const current = reviewDemo(old.id, "owner", old.version, action, "  Indicación exacta  ");
    assert.equal(reviewPatchIsSaved(current, old, action, "  Indicación exacta  "), true);
    for (const wrong of [
      null,
      { ...current, id: "another-job" },
      { ...current, version: old.version },
      { ...current, version: old.version + 2 },
      { ...current, revision_no: current.revision_no + 1 },
      { ...current, review_notes: "Indicación distinta" },
      { ...current, reviewed_at: null },
      { ...current, reviewed_by: "other-person" },
      { ...current, responsible_name: "Otra persona" },
    ]) assert.equal(reviewPatchIsSaved(wrong, old, action, "Indicación exacta"), false);
    for (const otherAction of ["approve", "trim", "add", "replace"].filter((value) => value !== action))
      assert.equal(reviewPatchIsSaved(current, old, otherAction, "Indicación exacta"), false);
    if (action === "approve") {
      assert.equal(reviewPatchIsSaved({ ...current, photo_paths: ["extra.jpg"] }, old, action, "Indicación exacta"), false);
      assert.equal(reviewPatchIsSaved({ ...current, width_cm: 1 }, old, action, "Indicación exacta"), false);
    } else {
      assert.equal(reviewPatchIsSaved({ ...current, photo_paths: ["old-proof.jpg"], photo_path: "old-proof.jpg" }, old, action, "Indicación exacta"), false);
      assert.equal(reviewPatchIsSaved({ ...current, status: "installed" }, old, action, "Indicación exacta"), false);
      assert.equal(reviewPatchIsSaved({ ...current, installed_at: old.installed_at }, old, action, "Indicación exacta"), false);
      assert.equal(reviewPatchIsSaved({ ...current, width_cm: action === "trim" ? null : old.width_cm }, old, action, "Indicación exacta"), false);
    }
  }
  localStorage.clear();
  const old = installedMat();
  const approved = reviewDemo(old.id, "owner", old.version, "approve", "Correcto");
  const unrelated = { ...approved, version: approved.version + 1, updated_at: "2026-10-09T20:00:00Z" };
  assert.equal(reviewPatchIsSaved(unrelated, approved, "approve", "Correcto"), false);
});
