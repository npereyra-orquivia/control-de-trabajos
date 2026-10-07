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
test('foto final acepta imágenes y rechaza vacías, formatos ajenos y más de10MB', () => {
  validatePhoto({ type: 'image/jpeg', size: 1000 })
  for (const file of [{type:'image/jpeg',size:0},{type:'text/html',size:100},{type:'image/jpeg',size:10485761}]) assert.throws(() => validatePhoto(file))
})
test('avance de trabajo conserva orden y no vuelve a abrir terminados', () => {
  assert.equal(nextStatus('measured'), 'cutting'); assert.equal(nextStatus('cutting'), 'cut')
  assert.equal(nextStatus('cut'), 'installed'); assert.equal(nextStatus('installed'), null)
})
