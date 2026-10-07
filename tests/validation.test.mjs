import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMeasure, validateInput, validatePhoto, nextStatus } from '../src/lib/validation.mjs'
test('medidas españolas admiten coma decimal sin redondear silenciosamente', () => {
  assert.equal(parseMeasure('120,50'), 120.5)
  assert.equal(parseMeasure('95.25'), 95.25)
  for (const value of ['0', '-1', 'NaN', '2,555', '1e3', '120cm', '', '10001']) assert.throws(() => parseMeasure(value))
})
test('trabajo exige tienda, dimensiones válidas y cantidad entera', () => {
  const job = { store_name: ' Centro ', address: '', material: '', notes: '', width_cm: 95, length_cm: 150, quantity: 1 }
  assert.equal(validateInput(job).store_name, 'Centro')
  assert.throws(() => validateInput({ ...job, store_name: ' ' }))
  assert.throws(() => validateInput({ ...job, quantity: 1.5 }))
  assert.throws(() => validateInput({ ...job, width_cm: Infinity }))
})
test('grosor conserva 17 mm, 20 mm o la opción No sé', () => {
  const job = { store_name: 'Centro', address: '', material: 'coco', notes: '', width_cm: 95, length_cm: 150, quantity: 1 }
  for (const thickness_mm of [17, 20, null]) {
    assert.equal(validateInput({ ...job, thickness_mm }).thickness_mm, thickness_mm)
  }
})
test('grosor rechaza medidas diferentes, cadenas, NaN y valores ajenos', () => {
  const job = { store_name: 'Centro', address: '', material: 'coco', notes: '', width_cm: 95, length_cm: 150, quantity: 1 }
  for (const thickness_mm of [18, 0, -17, 17.5, '17', '20', 'No sé', NaN, Infinity, false, {}]) {
    assert.throws(() => validateInput({ ...job, thickness_mm }), /grosor/)
  }
})
test('trabajos anteriores sin grosor se normalizan a No sé', () => {
  const job = { store_name: 'Centro', address: '', material: 'Coco natural · 20 mm', notes: '', width_cm: 95, length_cm: 150, quantity: 1 }
  assert.equal(validateInput(job).thickness_mm, null)
  assert.equal(validateInput({ ...job, thickness_mm: undefined }).thickness_mm, null)
  assert.equal(validateInput(job).material, 'Coco natural · 20 mm')
})
test('material acepta las tres opciones y conserva textos de trabajos anteriores', () => {
  const job = { store_name: 'Centro', address: '', notes: '', width_cm: 95, length_cm: 150, quantity: 1, thickness_mm: null }
  for (const material of ['coco', 'metálico', 'no hay', 'Sintético gris · 12 mm']) {
    assert.equal(validateInput({ ...job, material: ` ${material} ` }).material, material)
  }
})
test('foto final acepta imágenes y rechaza vacías, formatos ajenos y más de10MB', () => {
  validatePhoto({ type: 'image/jpeg', size: 1000 })
  for (const file of [{type:'image/jpeg',size:0},{type:'text/html',size:100},{type:'image/jpeg',size:10485761}]) assert.throws(() => validatePhoto(file))
})
test('avance de trabajo conserva orden y no vuelve a abrir terminados', () => {
  assert.equal(nextStatus('measured'), 'cutting'); assert.equal(nextStatus('cutting'), 'cut')
  assert.equal(nextStatus('cut'), 'installed'); assert.equal(nextStatus('installed'), null)
})
test('responsable conserva el nombre, recorta espacios y admite fichas antiguas sin asignar', () => {
  const job = { store_name: 'Centro', address: '', material: '', notes: '', width_cm: 95, length_cm: 150, quantity: 1 }
  assert.equal(validateInput(job).responsible_name, '')
  assert.equal(validateInput({ ...job, responsible_name: ' Andrés ' }).responsible_name, 'Andrés')
  for (const value of ['a'.repeat(101), 12, {}]) assert.throws(() => validateInput({ ...job, responsible_name: value }), /responsable/)
})
