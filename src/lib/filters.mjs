function normalized(value) {
  return (typeof value === "string" ? value : "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("es")
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

export function materialKey(material) {
  const value = normalized(material);
  if (!value) return "unspecified";
  if (value === "no hay") return "no hay";
  // Historical descriptions such as "Coco natural · 20 mm" retain their
  // detail in the job, while belonging to the same material filter.
  if (/^(?:felpudo\s+)?coco(?=$|[^\p{L}\p{N}])/u.test(value)) return "coco";
  if (
    /^(?:felpudo\s+)?(?:metalico|metalica|metalicos|metalicas|metallic)(?=$|[^\p{L}\p{N}])/u.test(value)
  ) return "metálico";
  return `other:${value}`;
}

export function getMaterialOptions(jobs, baseOptions) {
  const options = new Map();
  for (const option of baseOptions) {
    const key = materialKey(option.value);
    options.set(key, { value: key, label: option.label });
  }
  options.set("unspecified", { value: "unspecified", label: "Sin especificar" });
  const other = new Map();
  for (const job of jobs) {
    const key = materialKey(job.material);
    if (options.has(key) || other.has(key)) continue;
    other.set(key, {
      value: key,
      label: job.material.trim().replace(/\s+/g, " "),
    });
  }
  return [
    ...options.values(),
    ...[...other.values()].sort((a, b) =>
      a.label.localeCompare(b.label, "es", { sensitivity: "base" }),
    ),
  ];
}

export function responsibleKey(name) {
  const value = normalized(name);
  // Keep names separate from the special filter values, even if a saved
  // responsible happens to be called "All" or "Unassigned".
  return value ? `responsible:${value}` : "unassigned";
}

export function getResponsibleOptions(jobs, profiles) {
  const names = new Map();
  const addName = (name) => {
    const key = responsibleKey(name);
    if (key === "unassigned" || names.has(key)) return;
    names.set(key, {
      value: key,
      label: name.trim().replace(/\s+/g, " "),
    });
  };
  // Prefer the team's spelling, without losing saved names from older jobs.
  for (const profile of profiles) {
    if (profile.active) addName(profile.display_name);
  }
  for (const job of jobs) addName(job.responsible_name);
  return [
    { value: "unassigned", label: "Sin asignar" },
    ...[...names.values()].sort((a, b) =>
      a.label.localeCompare(b.label, "es", { sensitivity: "base" }),
    ),
  ];
}

export function matchesJob(job, filters) {
  if (filters.status !== "all" && job.status !== filters.status) return false;
  if (filters.material !== "all" && materialKey(job.material) !== filters.material)
    return false;
  if (
    filters.responsible &&
    filters.responsible !== "all" &&
    responsibleKey(job.responsible_name) !== filters.responsible
  ) return false;
  if (filters.thickness === "unknown") {
    if (job.thickness_mm != null) return false;
  } else if (filters.thickness !== "all") {
    if (
      !["17", "20"].includes(filters.thickness) ||
      job.thickness_mm !== Number(filters.thickness)
    ) return false;
  }
  const query = normalized(filters.search);
  return !query || normalized(`${job.store_name} ${job.address || ""} ${job.material || ""}`).includes(query);
}
