const archiveHeading = "Historial de importación (datos originales):\n";
const archiveMarker = `\n\n${archiveHeading}`;

// Imported chat provenance stays available without filling the working notes field.
export function prepareJobNotes(job) {
  const original = job?.notes || "";
  const archiveAtStart = original.startsWith(archiveHeading);
  const archiveIndex = archiveAtStart ? 0 : original.indexOf(archiveMarker);
  if (archiveIndex >= 0) {
    return {
      notes: original.slice(0, archiveIndex),
      archive: original.slice(archiveIndex + (archiveAtStart ? archiveHeading.length : archiveMarker.length)),
      original,
    };
  }
  const imported = original.includes("Listado recibido el ") && original.includes("Original:");
  if (!imported) return { notes: original, archive: "", original };

  const firstLine = original.split(/\r?\n/, 1)[0];
  const notes = firstLine
    .replace(/\s*Original:.*$/, "")
    .split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚ])/u)
    .filter((sentence) => {
      if (/^(Felpudo \d+ de \d+\.|Puerta \d+ de \d+\.|Cada puerta tiene su propia ficha|Misma medida que el felpudo|Nombre conservado exactamente|Lado mayor guardado|Se marca Coco y se conserva la descripción completa)/.test(sentence)) return false;
      if (job.thickness_mm != null && /^(Fondo|Espesor|Fuera de las opciones|Se conserva sin redondear|No se ha dado un espesor|Falta espesor numérico)/.test(sentence)) return false;
      return true;
    })
    .join(" ")
    .trim();
  return { notes, archive: original, original };
}

export function combineJobNotes(notes, prepared) {
  if (notes === prepared.notes) return prepared.original;
  if (!prepared.archive) return notes;
  const workingNotes = notes.trim();
  return `${workingNotes ? workingNotes + archiveMarker : archiveHeading}${prepared.archive}`;
}

export function editableNotesLimit(prepared) {
  return prepared.archive ? Math.max(0, 3000 - prepared.archive.length - archiveMarker.length) : 3000;
}
