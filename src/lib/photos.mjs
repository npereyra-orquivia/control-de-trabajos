export function jobPhotoPaths(job) {
  if (!job) return [];
  const paths = Array.isArray(job.photo_paths) && job.photo_paths.length
    ? job.photo_paths
    : job.photo_path ? [job.photo_path] : [];
  return [...new Set(paths.filter((path) => typeof path === "string" && path.length > 0))];
}

export function appendPhotoPaths(job, addedPaths) {
  return [...new Set([...jobPhotoPaths(job), ...addedPaths])];
}

// A lost RPC response may hide a successful save. Confirm the whole patch before
// treating it as complete; merely finding one uploaded image is insufficient.
export function photoPatchIsSaved(job, patch, expectedVersion) {
  if (!job || job.version !== expectedVersion + 1) return false;
  return Object.entries(patch).every(([key, value]) => {
    if (key === "photo_paths") {
      const saved = jobPhotoPaths(job);
      return Array.isArray(value) && saved.length === value.length &&
        saved.every((path, index) => path === value[index]);
    }
    return job[key] === value;
  });
}
