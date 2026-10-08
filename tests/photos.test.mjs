import test from "node:test";
import assert from "node:assert/strict";
import { appendPhotoPaths, jobPhotoPaths, photoPatchIsSaved } from "../src/lib/photos.mjs";

test("galería conserva la foto legacy y normaliza listas sin duplicados", () => {
  assert.deepEqual(jobPhotoPaths(null), []);
  assert.deepEqual(jobPhotoPaths({ photo_path: "job/old.jpg" }), ["job/old.jpg"]);
  assert.deepEqual(jobPhotoPaths({ photo_paths: [], photo_path: "job/old.jpg" }), ["job/old.jpg"]);
  assert.deepEqual(jobPhotoPaths({ photo_paths: ["job/a.jpg", "job/b.jpg", "job/a.jpg"], photo_path: "ignored.jpg" }), ["job/a.jpg", "job/b.jpg"]);
  assert.deepEqual(appendPhotoPaths({ photo_path: "job/old.jpg" }, ["job/a.jpg", "job/a.jpg", "job/b.jpg"]), ["job/old.jpg", "job/a.jpg", "job/b.jpg"]);
});

test("respuesta perdida sólo se considera guardada si coincide toda la galería y el patch", () => {
  const patch = { status: "installed", responsible_name: "Nicole", photo_paths: ["job/a.jpg", "job/b.jpg"] };
  const saved = { ...patch, photo_path: "job/a.jpg", version: 8 };
  assert.equal(photoPatchIsSaved(saved, patch, 7), true);
  assert.equal(photoPatchIsSaved({ ...saved, version: 7 }, patch, 7), false);
  assert.equal(photoPatchIsSaved({ ...saved, version: 9 }, patch, 7), false);
  assert.equal(photoPatchIsSaved({ ...saved, photo_paths: ["job/a.jpg"] }, patch, 7), false);
  assert.equal(photoPatchIsSaved({ ...saved, status: "cut" }, patch, 7), false);
  assert.equal(photoPatchIsSaved({ ...saved, responsible_name: "Lili" }, patch, 7), false);
  assert.equal(photoPatchIsSaved(null, patch, 7), false);
});
