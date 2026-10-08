import test from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { reportRows, createReportDocument, exportReport } from "../src/lib/reports.mjs";

function decodedPdf(document) {
  const pdf = Buffer.from(document.output("arraybuffer"));
  const plain = pdf.toString("latin1");
  const contents = [plain];
  let offset = 0;
  while (true) {
    const start = plain.indexOf("stream\n", offset);
    if (start < 0) break;
    const end = plain.indexOf("\nendstream", start + 7);
    if (end < 0) break;
    const stream = pdf.subarray(start + 7, end);
    try { contents.push(inflateSync(stream).toString("latin1")); }
    catch { contents.push(stream.toString("latin1")); }
    offset = end + 10;
  }
  return contents.join("\n");
}

test("reports keep the selected type and never include staff, notes or thickness", () => {
  const source = [
    { id: "a", store_name: "Local <1>", status: "installed", width_cm: 200, length_cm: 96, quantity: 1, thickness_mm: 20, responsible_name: "PERSONAL_NO_EXPORTAR", notes: "NOTA_NO_EXPORTAR", installed_by: "UUID_NO_EXPORTAR", cut_at: "2026-10-09T12:00:00Z", installed_at: "2026-10-09T13:00:00Z", photo_paths: ["a/one.jpg", "a/two.jpg"] },
    { id: "b", job_kind: "dehumidifier", store_name: "Otro", status: "pending_installation", quantity: 2, notes: "OTRA_NOTA_NO_EXPORTAR" },
  ];
  const rows = reportRows(source, "mat");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dimensions, "200 x 96 cm");
  assert.deepEqual(rows[0].photos, ["a/one.jpg", "a/two.jpg"]);
  assert.equal(rows[0].cut, "9/10/2026");
  assert.deepEqual(Object.keys(rows[0]).sort(), ["id", "name", "status", "dimensions", "quantity", "cut", "installed", "photos"].sort());
  const pdf = decodedPdf(createReportDocument(rows, "mat", { createdAt: new Date("2026-10-09T14:00:00Z") }));
  for (const forbidden of ["PERSONAL_NO_EXPORTAR", "NOTA_NO_EXPORTAR", "UUID_NO_EXPORTAR", "Espesor", "responsible_name"]) assert.ok(!pdf.includes(forbidden));
  assert.ok(pdf.includes("Nicole Pereyra Bonija"));
  assert.ok(pdf.includes("RESUMEN DE TRABAJOS"));
  assert.ok(pdf.includes("200 x 96 cm"));
  assert.ok(!pdf.includes("Otro"));
  assert.equal(reportRows(source, "dehumidifier")[0].quantity, 2);
});

test("reports paginate long names, tables and multiple photos", () => {
  const jobs = Array.from({ length: 75 }, (_, i) => ({ id: String(i), store_name: `Local ${i} ${"nombre largo ".repeat(8)}`, status: "pending_measurement", quantity: 1, photo_paths: i === 0 ? ["1", "2", "3", "4", "5", "6", "7"] : [] }));
  const pdf = createReportDocument(reportRows(jobs, "mat"), "mat");
  assert.ok(pdf.getNumberOfPages() > 5);
  assert.ok(pdf.output().startsWith("%PDF-"));
  const content = decodedPdf(pdf);
  assert.ok(content.includes("Local 74"));
  assert.ok(content.includes("Foto 7"));
});

test("report dates use Madrid and appliance rows never show mat measurements", () => {
  const row = reportRows([{ id: "a", job_kind: "dehumidifier", store_name: "Centro", quantity: 3, status: "installed", width_cm: 200, length_cm: 100, installed_at: "2026-10-08T23:30:00Z", photo_paths: [] }], "dehumidifier")[0];
  assert.equal(row.installed, "9/10/2026");
  const content = decodedPdf(createReportDocument([row], "dehumidifier"));
  assert.ok(content.includes("3 aparatos"));
  assert.ok(!content.includes("200 x 100"));
  assert.ok(!content.includes("Medidas"));
});

test("export stops before downloading when the selected type is empty or a photo is missing", async () => {
  let resolves = 0;
  const resolve = async () => { resolves++; return {}; };
  await assert.rejects(() => exportReport([{ job_kind: "dehumidifier", quantity: 3 }], "mat", resolve, "/"), /No hay trabajos/);
  assert.equal(resolves, 0);
  await assert.rejects(() => exportReport([{ id: "a", job_kind: "mat", store_name: "Centro", quantity: 1, status: "installed", photo_paths: ["a/photo.jpg"] }], "mat", resolve, "/"), /Falta una fotografía/);
  assert.equal(resolves, 1);
});

test("a failed photo download leaves the report unsaved and gives a retryable error", async () => {
  const OriginalImage = globalThis.Image;
  globalThis.Image = class {
    set src(url) { if (url) queueMicrotask(() => this.onerror?.()); }
  };
  try {
    await assert.rejects(() => exportReport([{ id: "a", job_kind: "mat", store_name: "Centro", quantity: 1, status: "installed", photo_paths: ["a/photo.jpg"] }], "mat", async () => ({ "a/photo.jpg": "https://invalid.example/photo.jpg" }), "/"), /cargar una foto/);
  } finally {
    if (OriginalImage === undefined) delete globalThis.Image;
    else globalThis.Image = OriginalImage;
  }
});
