import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMeasure, validateInput, validatePhoto, nextStatus } from '../src/lib/validation.mjs'
test('medidas españolas admiten coma decimal sin redondear silenciosamente', () => {
  assert.equal(parseMeasure('120,50'), 120.5)
  assert.equal(parseMeasure('95.25'), 95.25)
  for (const value of ['0', '-1', 'NaN', '2,555', '1e3', '120cm', '', '10001']) assert.throws(() => parseMeasure(value))
})
test('cada trabajo exige tienda, dimensiones válidas y representa un felpudo', () => {
  const job = { store_name: ' Centro ', address: '', material: '', notes: '', width_cm: 95, length_cm: 150, quantity: 1 }
  assert.equal(validateInput(job).store_name, 'Centro')
  assert.throws(() => validateInput({ ...job, store_name: ' ' }))
  for (const quantity of [0, 2, 100, 1.5, '1', undefined]) assert.throws(() => validateInput({ ...job, quantity }), /un solo felpudo/)
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
  assert.equal(nextStatus('measured'), 'cut'); assert.equal(nextStatus('cutting'), null)
  assert.equal(nextStatus('cut'), 'installed'); assert.equal(nextStatus('installed'), null)
})
test('responsable conserva el nombre, recorta espacios y admite fichas antiguas sin asignar', () => {
  const job = { store_name: 'Centro', address: '', material: '', notes: '', width_cm: 95, length_cm: 150, quantity: 1 }
  assert.equal(validateInput(job).responsible_name, '')
  assert.equal(validateInput({ ...job, responsible_name: ' Andrés ' }).responsible_name, 'Andrés')
  for (const value of ['a'.repeat(101), 12, {}]) assert.throws(() => validateInput({ ...job, responsible_name: value }), /responsable/)
})

test('un local nuevo o una sustitución puede esperar a ser medido, sin inventar dimensiones', () => {
  const draft = { store_name: 'Coach', address: '', material: 'coco', notes: '', width_cm: null, length_cm: null, quantity: 1, job_kind: 'mat' }
  const saved = validateInput(draft)
  assert.equal(saved.status, 'pending_measurement')
  assert.equal(saved.width_cm, null)
  assert.equal(saved.length_cm, null)
  for (const status of ['measured', 'cut', 'installed', 'pending_adjustment'])
    assert.throws(() => validateInput(draft, status), /medidas/)
  assert.throws(() => validateInput({ ...draft, width_cm: 100 }), /medidas/)
  assert.equal(validateInput({ ...draft, width_cm: 100, length_cm: 200 }, 'pending_measurement').status, 'pending_measurement')
  assert.equal(validateInput({ ...draft, width_cm: 100, length_cm: 200 }, 'measured').status, 'measured')
})

test('deshumidificadores registran unidades enteras sin medidas, material ni grosor de felpudo', () => {
  const device = { store_name: 'Centro', address: '', material: 'coco', notes: '', width_cm: 95, length_cm: 150, quantity: 4, thickness_mm: 20, job_kind: 'dehumidifier' }
  const saved = validateInput(device)
  assert.equal(saved.quantity, 4)
  assert.equal(saved.status, 'pending_installation')
  assert.equal(saved.width_cm, null)
  assert.equal(saved.length_cm, null)
  assert.equal(saved.thickness_mm, null)
  assert.equal(saved.material, '')
  for (const quantity of [0, -1, 1.5, '4', null, undefined, NaN, Infinity, 2147483648])
    assert.throws(() => validateInput({ ...device, quantity }), /deshumidificadores/)
  for (const status of ['measured', 'cut', 'pending_measurement', 'pending_adjustment'])
    assert.throws(() => validateInput(device, status), /deshumidificadores/)
  assert.equal(validateInput(device, 'installed').status, 'installed')
  assert.throws(() => validateInput({ ...device, job_kind: 'unknown' }), /Felpudos/)
})

test('avance respeta las fases de aparatos, nuevas mediciones y ajustes', () => {
  assert.equal(nextStatus('pending_measurement', 'mat'), 'measured')
  assert.equal(nextStatus('pending_installation', 'dehumidifier'), 'installed')
  assert.equal(nextStatus('pending_adjustment', 'mat'), 'installed')
  assert.equal(nextStatus('measured', 'dehumidifier'), null)
  assert.equal(nextStatus('pending_installation', 'mat'), null)
  assert.equal(nextStatus('installed', 'dehumidifier'), null)
})
