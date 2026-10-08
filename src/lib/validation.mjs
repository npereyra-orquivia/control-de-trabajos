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
export function validateInput(input) {
  const responsible = input.responsible_name ?? "";
  if (typeof responsible !== "string" || responsible.trim().length > 100)
    throw new Error("El nombre del responsable debe tener como máximo 100 caracteres.");
  const thickness = input.thickness_mm === undefined ? null : input.thickness_mm;
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
  if (input.quantity !== 1)
    throw new Error("Cada trabajo corresponde a un solo felpudo.");
  if (
    !Number.isFinite(input.width_cm) ||
    input.width_cm <= 0 ||
    input.width_cm > 10000 ||
    !Number.isFinite(input.length_cm) ||
    input.length_cm <= 0 ||
    input.length_cm > 10000
  )
    throw new Error("Revisa las medidas del felpudo.");
  return {
    ...input,
    responsible_name: responsible.trim(),
    thickness_mm: thickness,
    store_name: input.store_name.trim(),
    address: input.address.trim(),
    material: input.material.trim(),
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
export function nextStatus(status) {
  return { measured: "cut", cut: "installed" }[status] ?? null;
}
