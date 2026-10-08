export function parseMeasure(value) {
  const normalized = String(value).trim().replace(",", ".");
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(normalized))
    throw new Error("Introduce una medida válida con hasta dos decimales.");
  const number = Number(normalized);
  if (number <= 0 || number > 10000)
    throw new Error(
      "Las medidas deben ser mayores que 0 y menores o iguales a 10.000 cm.",
    );
  return number;
}
function validDimension(value) {
  return Number.isFinite(value) && value > 0 && value <= 10000;
}

export function validateInput(input, requestedStatus) {
  const kind = input.job_kind ?? "mat";
  if (kind !== "mat" && kind !== "dehumidifier")
    throw new Error("Selecciona Felpudos o Deshumidificadores.");
  const responsible = input.responsible_name ?? "";
  if (typeof responsible !== "string" || responsible.trim().length > 100)
    throw new Error("El nombre del responsable debe tener como máximo 100 caracteres.");
  const thickness = kind === "dehumidifier" ? null : input.thickness_mm ?? null;
  if (thickness !== null && thickness !== 17 && thickness !== 20)
    throw new Error("El grosor debe ser 17 mm, 20 mm o «No sé».");
  if (!input.store_name.trim())
    throw new Error("Escribe el nombre de la tienda.");
  if (input.store_name.trim().length > 140)
    throw new Error("El nombre de la tienda es demasiado largo.");
  if (
    input.address.length > 300 ||
    input.material.length > 100 ||
    input.notes.length > 3000
  )
    throw new Error(
      "La dirección, el material o las notas son demasiado largos.",
    );
  const status = requestedStatus ?? input.status ?? (kind === "dehumidifier"
    ? "pending_installation"
    : input.width_cm == null && input.length_cm == null ? "pending_measurement" : "measured");
  if (kind === "dehumidifier") {
    if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0 || input.quantity > 2147483647)
      throw new Error("Introduce un número entero de deshumidificadores mayor que 0.");
    if (!["pending_installation", "installed"].includes(status))
      throw new Error("Los deshumidificadores están pendientes de colocar o colocados.");
  } else {
    if (input.quantity !== 1)
      throw new Error("Cada trabajo corresponde a un solo felpudo.");
    if (!["pending_measurement", "measured", "cut", "installed", "pending_adjustment"].includes(status))
      throw new Error("Selecciona una fase válida para el felpudo.");
    const noDimensions = input.width_cm == null && input.length_cm == null;
    const bothDimensions = validDimension(input.width_cm) && validDimension(input.length_cm);
    if (!bothDimensions && !(status === "pending_measurement" && noDimensions))
      throw new Error("Revisa las medidas del felpudo. Completa ambos lados para marcarlo medido.");
  }
  return {
    ...input,
    job_kind: kind,
    status,
    width_cm: kind === "dehumidifier" ? null : input.width_cm ?? null,
    length_cm: kind === "dehumidifier" ? null : input.length_cm ?? null,
    responsible_name: responsible.trim(),
    thickness_mm: thickness,
    store_name: input.store_name.trim(),
    address: input.address.trim(),
    material: kind === "dehumidifier" ? "" : input.material.trim(),
    notes: input.notes.trim(),
  };
}
export function validatePhoto(file) {
  const types = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
  ];
  if (!types.includes(file.type))
    throw new Error("Elige una foto JPG, PNG, WebP o HEIC.");
  if (file.size === 0) throw new Error("La foto está vacía. Elige otra.");
  if (file.size > 10 * 1024 * 1024)
    throw new Error("La foto supera 10 MB. Elige una más pequeña.");
}
export function nextStatus(status, kind) {
  if (kind === "dehumidifier") return status === "pending_installation" ? "installed" : null;
  if (kind === "mat" && status === "pending_installation") return null;
  return {
    pending_measurement: "measured",
    measured: "cut",
    cut: "installed",
    pending_installation: "installed",
    pending_adjustment: "installed",
  }[status] ?? null;
}
