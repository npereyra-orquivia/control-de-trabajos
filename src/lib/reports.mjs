import { jsPDF } from "jspdf";
import { jobPhotoPaths } from "./photos.mjs";

const GREEN = [32, 63, 57];
const INK = [37, 48, 44];
const MUTED = [102, 114, 106];
const PAPER = [242, 245, 240];
const LABELS = { pending_measurement: "Por medir", measured: "Medido", cut: "Cortado", installed: "Colocado", pending_installation: "Por colocar", pending_adjustment: "Por ajustar" };
const safeText = value => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[\u2010-\u2015]/g, "-").slice(0, 160);
const number = value => Number(value).toLocaleString("es-ES", { maximumFractionDigits: 2 });
const date = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid" }).format(new Date(value)) : "Pendiente";

// Explicit allowlist: operational notes, identities and audit history never enter a report.
export function reportRows(jobs, kind) {
  return jobs.filter(job => (job.job_kind || "mat") === kind).map(job => ({
    id: job.id,
    name: safeText(job.store_name),
    status: LABELS[job.status] || "Pendiente",
    dimensions: kind === "mat" && job.width_cm > 0 && job.length_cm > 0 ? `${job.rework_kind === "add" ? "Parte añadida: " : ""}${number(job.width_cm)} x ${number(job.length_cm)} cm` : "Pendiente de medir",
    quantity: kind === "dehumidifier" ? job.quantity : 1,
    cut: date(job.cut_at),
    installed: date(job.installed_at),
    photos: jobPhotoPaths(job),
  }));
}

export function createReportDocument(rows, kind, { logo, images = new Map(), createdAt = new Date() } = {}) {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
  const title = kind === "mat" ? "Informe de felpudos" : "Informe de deshumidificadores";
  const reportDate = date(createdAt.toISOString());
  const left = 16, right = 194, bottom = 276;
  let y = 16;
  doc.setProperties({ title, author: "Nicole Pereyra Bonija", subject: "Informe de trabajos", creator: "Control de trabajos" });
  doc.setCreationDate(createdAt);

  function text(value, x, baseline, size = 10, weight = "normal", color = INK) {
    doc.setFont("helvetica", weight); doc.setFontSize(size); doc.setTextColor(...color);
    doc.text(value, x, baseline);
  }
  function header(first = false) {
    if (first && logo) doc.addImage(logo, "PNG", left, 12, 60, 24.52);
    else text("ORQUIVIA", left, 18, 12, "bold", GREEN);
    text(title, left, first ? 49 : 29, first ? 23 : 16, "bold", GREEN);
    text(`Fecha del informe: ${reportDate}`, left, first ? 59 : 37, 9, "normal", MUTED);
    if (first) text("Creado por: Nicole Pereyra Bonija", left, 65, 9, "normal", MUTED);
    doc.setDrawColor(191, 204, 192); doc.line(left, first ? 71 : 42, right, first ? 71 : 42);
    y = first ? 81 : 52;
  }
  function newPage() { doc.addPage(); header(); }
  function ensure(height) { if (y + height > bottom) newPage(); }
  header(true);
  const total = rows.reduce((sum, row) => sum + row.quantity, 0);
  const completed = rows.filter(row => row.status === "Colocado").reduce((sum, row) => sum + row.quantity, 0);
  doc.setFillColor(...PAPER); doc.roundedRect(left, y - 4, right - left, 22, 2, 2, "F");
  text(`${rows.length} ${kind === "mat" ? rows.length === 1 ? "felpudo" : "felpudos" : rows.length === 1 ? "local" : "locales"} en esta selección`, left + 5, y + 3, 11, "bold", GREEN);
  text(kind === "mat" ? `${completed} colocado${completed === 1 ? "" : "s"} · ${total - completed} pendiente${total - completed === 1 ? "" : "s"}` : `${total} aparato${total === 1 ? "" : "s"} · ${completed} colocado${completed === 1 ? "" : "s"} · ${total - completed} por colocar`, left + 5, y + 10, 9);
  y += 29;
  text("RESUMEN DE TRABAJOS", left, y, 10, "bold", GREEN); y += 6;
  const columns = kind === "mat" ? [16, 76, 116, 144, 170] : [16, 85, 108, 150];
  const widths = kind === "mat" ? [57, 37, 25, 23, 24] : [65, 19, 38, 44];
  const headings = kind === "mat" ? ["Local", "Medidas", "Estado", "Cortado", "Colocado"] : ["Local", "Unidades", "Estado", "Colocado"];
  function tableHeader() {
    doc.setFillColor(...GREEN); doc.rect(left, y, right - left, 10, "F");
    headings.forEach((heading, i) => text(heading, columns[i] + 2, y + 6, 8, "bold", [255, 255, 255])); y += 10;
  }
  tableHeader();
  rows.forEach((row, index) => {
    doc.setFont("helvetica", "normal"); doc.setFontSize(8);
    const values = kind === "mat" ? [row.name, row.dimensions, row.status, row.cut, row.installed] : [row.name, String(row.quantity), row.status, row.installed];
    const lines = values.map((value, i) => doc.splitTextToSize(value, widths[i] - 4));
    const height = Math.max(12, Math.max(...lines.map(line => line.length)) * 4 + 6);
    if (y + height > bottom) { newPage(); tableHeader(); }
    if (index % 2 === 0) { doc.setFillColor(...PAPER); doc.rect(left, y, right - left, height, "F"); }
    lines.forEach((line, i) => text(line, columns[i] + 2, y + 5.5, 8));
    doc.setDrawColor(223, 229, 221); doc.line(left, y + height, right, y + height); y += height;
  });

  const photographed = rows.filter(row => row.photos.length);
  if (photographed.length) {
    newPage(); text("FOTOGRAFÍAS DE LOS TRABAJOS", left, y, 13, "bold", GREEN); y += 11;
    for (const row of photographed) {
      for (let offset = 0; offset < row.photos.length; offset += 3) {
        doc.setFont("helvetica", "bold"); doc.setFontSize(12);
        const nameLines = doc.splitTextToSize(row.name + (offset ? " (continuación)" : ""), right - left);
        const headingHeight = nameLines.length * 5;
        ensure(headingHeight + 72);
        text(nameLines, left, y, 12, "bold", GREEN); y += headingHeight;
        text(kind === "mat" ? `${row.dimensions} · ${row.status} · Colocado: ${row.installed}` : `${row.quantity} aparato${row.quantity === 1 ? "" : "s"} · ${row.status} · Colocado: ${row.installed}`, left, y + 1, 9, "normal", MUTED); y += 6;
        row.photos.slice(offset, offset + 3).forEach((path, index) => {
          const x = left + index * 61;
          doc.setFillColor(...PAPER); doc.rect(x, y, 56, 56, "F");
          const data = images.get(path);
          if (data) doc.addImage(data, "JPEG", x, y, 56, 56, `${row.id}-${offset + index}`, "FAST");
          else text("Foto no disponible", x + 3, y + 29, 8, "normal", MUTED);
          text(`Foto ${offset + index + 1}`, x, y + 61, 8, "normal", MUTED);
        });
        y += 69;
      }
    }
  }
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page); doc.setDrawColor(223, 229, 221); doc.line(left, 283, right, 283);
    text(`ORQUIVIA · ${title}`, left, 289, 8, "normal", MUTED);
    text(`${page} / ${pages}`, right - 12, 289, 8, "normal", MUTED);
  }
  return doc;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timeout = setTimeout(() => { image.src = ""; reject(new Error("La foto tardó demasiado en cargar.")); }, 20000);
    image.crossOrigin = "anonymous";
    image.onload = () => { clearTimeout(timeout); resolve(image); };
    image.onerror = () => { clearTimeout(timeout); reject(new Error("No se ha podido cargar una foto. Vuelve a exportar el informe.")); };
    image.src = url;
  });
}

// Fit the whole photograph inside a square. Inspection evidence is never cropped.
async function photoSquare(url) {
  const image = await loadImage(url);
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 900;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No se puede preparar la fotografía.");
  context.fillStyle = "#f2f5f0"; context.fillRect(0, 0, 900, 900);
  const scale = Math.min(900 / image.naturalWidth, 900 / image.naturalHeight);
  const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
  context.drawImage(image, (900 - width) / 2, (900 - height) / 2, width, height);
  return canvas.toDataURL("image/jpeg", 0.84);
}

export async function exportReport(jobs, kind, resolvePhotoUrls, baseUrl) {
  const rows = reportRows(jobs, kind);
  if (!rows.length) throw new Error("No hay trabajos en la selección actual.");
  const paths = [...new Set(rows.flatMap(row => row.photos))];
  const urls = await resolvePhotoUrls(paths);
  const images = new Map();
  // A small batch limits memory and download pressure on mobile devices.
  for (let offset = 0; offset < paths.length; offset += 3) {
    await Promise.all(paths.slice(offset, offset + 3).map(async path => {
      if (!urls[path]) throw new Error("Falta una fotografía. Actualiza los trabajos y vuelve a exportar.");
      images.set(path, await photoSquare(urls[path]));
    }));
  }
  const image = await loadImage(`${baseUrl}logo-completo.svg`);
  const canvas = document.createElement("canvas"); canvas.width = 2158; canvas.height = 882;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No se puede preparar el logo.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const createdAt = new Date();
  const doc = createReportDocument(rows, kind, { images, logo: canvas.toDataURL("image/png"), createdAt });
  const filename = `informe-${kind === "mat" ? "felpudos" : "deshumidificadores"}-${new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(createdAt)}.pdf`;
  await doc.save(filename, { returnPromise: true });
}
