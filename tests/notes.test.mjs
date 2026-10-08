import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareJobNotes, combineJobNotes, editableNotesLimit } from '../src/lib/notes.mjs';
import { validateInput } from '../src/lib/validation.mjs';

test('imported notes show unresolved data while retaining every original line', () => {
  const original = 'Felpudo 3 de 3. Fondo 2 cm (20 mm). Falta número de local.\nLado mayor guardado en Ancho.\nListado recibido el 07/10/2026.\nOriginal: tres felpudos\nRevisión del chat: responsable Byron.';
  const prepared = prepareJobNotes({ notes: original, thickness_mm: 20 });
  assert.equal(prepared.notes, 'Falta número de local.');
  assert.equal(prepared.archive, original);
  assert.equal(combineJobNotes(prepared.notes, prepared), original);
  const edited = combineJobNotes('Revisar fibra.', prepared);
  assert.equal(prepareJobNotes({ notes: edited, thickness_mm: 20 }).notes, 'Revisar fibra.');
  assert.equal(prepareJobNotes({ notes: edited, thickness_mm: 20 }).archive, original);
  assert.ok(edited.endsWith(original));
});

test('unknown thickness and mixed material warnings remain visible', () => {
  const original = 'Fondo indicado: 2,2 cm (22 mm). Fuera de las opciones 17/20 mm; se conserva aquí sin redondear.\nListado recibido el 07/10/2026.\nOriginal: 148 IRO';
  assert.match(prepareJobNotes({ notes: original, thickness_mm: null }).notes, /22 mm/);
  assert.match(prepareJobNotes({ notes: original, thickness_mm: null }).notes, /sin redondear/);
  assert.equal(prepareJobNotes({ notes: original, thickness_mm: 20 }).notes, '');
  const bookkeepingOnly = 'Lado mayor guardado en Ancho (primera medida), a petición del usuario.\nListado recibido el 07/10/2026.\nOriginal: 128 purificación';
  assert.equal(prepareJobNotes({ notes: bookkeepingOnly, thickness_mm: 20 }).notes, '');
  const mixed = 'Material mixto indicado: Coco con Metálicos de rejas. Espesor no apuntado.\nListado recibido el 07/10/2026.\nOriginal: mixto';
  assert.match(prepareJobNotes({ notes: mixed, thickness_mm: null }).notes, /Metálicos de rejas/);
});

test('ordinary user notes stay untouched and available capacity accounts for retained history', () => {
  const prepared = prepareJobNotes({ notes: 'Cortar siguiendo la fibra.\nPuerta lateral.', thickness_mm: 17 });
  assert.equal(prepared.notes, prepared.original);
  assert.equal(prepared.archive, '');
  assert.equal(combineJobNotes('Nueva nota.', prepared), 'Nueva nota.');
  const imported = prepareJobNotes({ notes: 'Espesor no indicado.\nListado recibido el 07/10/2026.\nOriginal: coco', thickness_mm: null });
  assert.equal(combineJobNotes('n'.repeat(editableNotesLimit(imported)), imported).length, 3000);
});

test('clearing imported working notes survives validation and reopening without nesting history', () => {
  const original = 'Espesor no indicado.\nListado recibido el 07/10/2026.\nOriginal: coco\nRevisión del chat: conservada íntegramente.';
  const input = { store_name: 'Centro', address: '', material: 'coco', notes: original, width_cm: 95, length_cm: 150, quantity: 1, thickness_mm: null };
  const initiallyPrepared = prepareJobNotes(input);
  const cleared = validateInput({ ...input, notes: combineJobNotes('', initiallyPrepared) });
  const reopened = prepareJobNotes(cleared);
  assert.equal(reopened.notes, '');
  assert.equal(reopened.archive, original);
  assert.equal(combineJobNotes('', reopened), cleared.notes);
  const edited = validateInput({ ...input, notes: combineJobNotes('Revisar entrada.', reopened) });
  const afterEdit = prepareJobNotes(edited);
  assert.equal(afterEdit.notes, 'Revisar entrada.');
  assert.equal(afterEdit.archive, original);
  assert.equal((edited.notes.match(/Historial de importación/g) || []).length, 1);
  // Also recover already trimmed records produced by the earlier delimiter format.
  const oldTrimmed = `\n\nHistorial de importación (datos originales):\n${original}`.trim();
  assert.equal(prepareJobNotes({ ...input, notes: oldTrimmed }).archive, original);
});
