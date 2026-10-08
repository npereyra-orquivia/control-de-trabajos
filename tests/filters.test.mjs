import test from "node:test";
import assert from "node:assert/strict";
import { materialKey, getMaterialOptions, responsibleKey, getResponsibleOptions, matchesJob, sortJobsForWorkspace } from "../src/lib/filters.mjs";

const baseOptions = [
  { value: "coco", label: "Coco" },
  { value: "metálico", label: "Metálico" },
  { value: "no hay", label: "No hay" },
];
const all = { status: "all", material: "all", thickness: "all", search: "" };
const jobs = [
  { status: "measured", store_name: "Tienda Café Norte", address: "Calle Árbol", material: "coco", thickness_mm: 20 },
  { status: "cutting", store_name: "Tienda Sur", address: "Plaza Centro", material: "metálico", thickness_mm: 17 },
  { status: "measured", store_name: "Tienda Oeste", material: "", thickness_mm: null },
  { status: "measured", store_name: "Tienda Este", material: "no hay", thickness_mm: null },
  { status: "cut", store_name: "Tienda Río", material: "Felpudo plástico", thickness_mm: null },
];
const ids = (filters) => jobs.filter((job) => matchesJob(job, { ...all, ...filters })).map((job) => job.store_name);

test("missing material remains distinct from an explicit No hay", () => {
  for (const value of ["", "   ", undefined, null]) assert.equal(materialKey(value), "unspecified");
  assert.equal(materialKey("  NO   HAY  "), "no hay");
  assert.deepEqual(ids({ material: "unspecified" }), ["Tienda Oeste"]);
  assert.deepEqual(ids({ material: "no hay" }), ["Tienda Este"]);
});

test("legacy material descriptions join known groups only at a whole material word", () => {
  for (const value of ["COCO", "Coco natural · 20 mm", "Felpudo coco", "Coco con rejas metálicas"])
    assert.equal(materialKey(value), "coco");
  for (const value of ["METÁLICA", "metalico", "Felpudo metálico", "Metallic"])
    assert.equal(materialKey(value), "metálico");
  assert.equal(materialKey("coconut"), "other:coconut");
  assert.equal(materialKey("metalicopoliéster"), "other:metalicopoliester");
});

test("unlisted materials are selectable, deduplicated, and preserve their display description", () => {
  const options = getMaterialOptions([
    ...jobs,
    { material: " FELPUDO PLASTICO " },
    { material: "Sintético · 12 mm" },
    { material: "Coco natural · 20 mm" },
  ], baseOptions);
  assert.deepEqual(options.slice(0, 4), [
    ...baseOptions,
    { value: "unspecified", label: "Sin especificar" },
  ]);
  assert.deepEqual(options.slice(4), [
    { value: "other:felpudo plastico", label: "Felpudo plástico" },
    { value: "other:sintetico · 12 mm", label: "Sintético · 12 mm" },
  ]);
  assert.deepEqual(ids({ material: materialKey("felpudo plastico") }), ["Tienda Río"]);
  assert.equal(jobs[4].material, "Felpudo plástico");
});

test("status, material, thickness, and search combine instead of overriding one another", () => {
  assert.deepEqual(ids({ status: "measured", material: "coco", thickness: "20", search: "cafe" }), ["Tienda Café Norte"]);
  assert.deepEqual(ids({ status: "cutting", material: "coco", thickness: "20", search: "cafe" }), []);
  assert.deepEqual(ids({ status: "measured", material: "metálico", thickness: "20", search: "cafe" }), []);
  assert.deepEqual(ids({ status: "measured", material: "coco", thickness: "17", search: "cafe" }), []);
  assert.deepEqual(ids({ status: "measured", material: "coco", thickness: "20", search: "sur" }), []);
  assert.equal(ids({}).length, jobs.length);
});

test("search ignores accents, case, and surrounding or repeated whitespace across existing fields", () => {
  assert.deepEqual(ids({ search: "  CAFE   NORTE  " }), ["Tienda Café Norte"]);
  assert.deepEqual(ids({ search: "arbol" }), ["Tienda Café Norte"]);
  assert.deepEqual(ids({ search: "METALICO" }), ["Tienda Sur"]);
  assert.equal(ids({ search: "    " }).length, jobs.length);
});

test("unknown thickness includes null and older rows with no field, and excludes measured values", () => {
  assert.deepEqual(ids({ thickness: "unknown" }), ["Tienda Oeste", "Tienda Este", "Tienda Río"]);
  assert.deepEqual(ids({ thickness: "17" }), ["Tienda Sur"]);
  assert.deepEqual(ids({ thickness: "20" }), ["Tienda Café Norte"]);
  assert.equal(matchesJob({ status: "measured", store_name: "Legacy", material: "coco" }, { ...all, thickness: "unknown" }), true);
  assert.equal(matchesJob(jobs[0], { ...all, thickness: "unknown" }), false);
  assert.equal(matchesJob(jobs[0], { ...all, thickness: "18" }), false);
});

test("responsible names normalize accents and spacing while matching the whole name", () => {
  assert.equal(responsibleKey("  ANDRES   GARCIA  "), responsibleKey("Andrés García"));
  assert.notEqual(responsibleKey("Andrés"), responsibleKey("Andrés García"));
  assert.notEqual(responsibleKey("Lili"), responsibleKey("Liliana"));
  for (const name of ["", "   ", null, undefined]) assert.equal(responsibleKey(name), "unassigned");
  assert.equal(responsibleKey("All"), "responsible:all");
  assert.equal(responsibleKey("Unassigned"), "responsible:unassigned");
});

test("responsible options include active team members and saved names outside the team", () => {
  const assigned = [
    { responsible_name: "  ANDRES   GARCIA " },
    { responsible_name: "Byron" },
    { responsible_name: "Ex trabajador" },
    { responsible_name: " EX  TRABAJADOR " },
    { responsible_name: "Andrés" },
    { responsible_name: null },
    {},
  ];
  const profiles = [
    { display_name: "Andrés García", active: true },
    { display_name: "Nicole", active: true },
    { display_name: "Ex trabajador", active: false },
    { display_name: "Inactivo sin trabajo", active: false },
    { display_name: "", active: true },
  ];
  assert.deepEqual(getResponsibleOptions(assigned, profiles), [
    { value: "unassigned", label: "Sin asignar" },
    { value: "responsible:andres", label: "Andrés" },
    { value: "responsible:andres garcia", label: "Andrés García" },
    { value: "responsible:byron", label: "Byron" },
    { value: "responsible:ex trabajador", label: "Ex trabajador" },
    { value: "responsible:nicole", label: "Nicole" },
  ]);
  assert.equal(assigned[0].responsible_name, "  ANDRES   GARCIA ");
});

test("unassigned filter includes missing, empty, and whitespace names only", () => {
  const assigned = [
    ...[undefined, null, "", "  ", "Nicole", "Unassigned"].map((responsible_name) => ({ ...jobs[0], responsible_name })),
  ];
  assert.equal(assigned.filter((job) => matchesJob(job, { ...all, responsible: "unassigned" })).length, 4);
  assert.equal(assigned.filter((job) => matchesJob(job, { ...all, responsible: "all" })).length, 6);
  assert.equal(assigned.filter((job) => matchesJob(job, { ...all, responsible: responsibleKey("Unassigned") })).length, 1);
});

test("responsible selection combines with status, material, thickness, and local search", () => {
  const job = { ...jobs[0], responsible_name: "  ANDRES  GARCIA  " };
  const filters = { status: "measured", material: "coco", thickness: "20", search: "cafe", responsible: responsibleKey("Andrés García") };
  assert.equal(matchesJob(job, filters), true);
  for (const changed of [
    { responsible: responsibleKey("Nicole") },
    { responsible: "unassigned" },
    { status: "cut" },
    { material: "metálico" },
    { thickness: "17" },
    { search: "sur" },
  ]) assert.equal(matchesJob(job, { ...filters, ...changed }), false);
  assert.equal(matchesJob(job, { ...all, responsible: "all" }), true);
  assert.equal(matchesJob(job, all), true);
});

test("completed jobs stay visible at the end without changing order within either group", () => {
  const ordered = [
    { ...jobs[0], store_name: "Colocado reciente", status: "installed" },
    { ...jobs[0], store_name: "Por cortar", status: "measured" },
    { ...jobs[0], store_name: "Colocado anterior", status: "installed" },
    { ...jobs[0], store_name: "Por colocar", status: "cut" },
  ];
  const original = ordered.slice();
  assert.deepEqual(sortJobsForWorkspace(ordered).map(job => job.store_name), [
    "Por cortar", "Por colocar", "Colocado reciente", "Colocado anterior",
  ]);
  assert.deepEqual(ordered, original);
  assert.deepEqual(sortJobsForWorkspace(ordered.filter(job => matchesJob(job, { ...all, status: "installed" }))).map(job => job.store_name), [
    "Colocado reciente", "Colocado anterior",
  ]);
});

test("mat and device areas stay separate while older mats retain their default area", () => {
  const mat = { ...jobs[0] };
  const device = { ...jobs[0], job_kind: "dehumidifier", status: "pending_installation", quantity: 3, material: "", thickness_mm: null };
  assert.equal(matchesJob(mat, { ...all, job_kind: "mat" }), true);
  assert.equal(matchesJob(mat, { ...all, job_kind: "dehumidifier" }), false);
  assert.equal(matchesJob(device, { ...all, job_kind: "dehumidifier" }), true);
  assert.equal(matchesJob(device, { ...all, job_kind: "mat" }), false);
  assert.equal(matchesJob(device, { ...all, material: "coco", thickness: "20", responsible: "all" }), true);
  assert.equal(matchesJob(device, { ...all, status: "installed" }), false);
});

test("inspection filters include installed pending reviews and reopened corrections", () => {
  const pending = { ...jobs[0], status: "installed" };
  const approved = { ...pending, review_status: "approved" };
  const correction = { ...jobs[0], status: "pending_measurement", review_status: "needs_adjustment" };
  assert.equal(matchesJob(pending, { ...all, review_status: "pending" }), true);
  assert.equal(matchesJob(jobs[0], { ...all, review_status: "pending" }), false);
  assert.equal(matchesJob(approved, { ...all, review_status: "approved" }), true);
  assert.equal(matchesJob(pending, { ...all, review_status: "approved" }), false);
  assert.equal(matchesJob(correction, { ...all, review_status: "needs_adjustment" }), true);
  assert.equal(matchesJob({ ...pending, job_kind: "dehumidifier" }, { ...all, review_status: "pending" }), false);
  assert.equal(matchesJob(correction, { ...all, review: "needs_adjustment" }), true);
});
