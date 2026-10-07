import test from "node:test";
import assert from "node:assert/strict";
import { materialKey, getMaterialOptions, matchesJob } from "../src/lib/filters.mjs";

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
