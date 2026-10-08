import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import test from 'node:test'

// PostgreSQL-compatible checks of the real schema. Auth and Storage are mocks;
// this does not exercise Supabase HTTP APIs or parallel database transactions.
test('schema, access policies, editing leases and complete workflow', { timeout: 30000 }, async (t) => {
  const db = new PGlite()
  const schema = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8')
  const thicknessMigration = await readFile(new URL('../supabase/migrations/20261007_add_thickness.sql', import.meta.url), 'utf8')
  const responsibleMigration = await readFile(new URL('../supabase/migrations/20261008_add_responsible.sql', import.meta.url), 'utf8')
  const workflowMigration = await readFile(new URL('../supabase/migrations/20261008_three_stages_one_mat.sql', import.meta.url), 'utf8')
  const photosMigration = await readFile(new URL('../supabase/migrations/20261008_multiple_photos.sql', import.meta.url), 'utf8')
  const typesMigration = await readFile(new URL('../supabase/migrations/20261009_job_types_and_reviews.sql', import.meta.url), 'utf8')
  const users = Array.from({ length: 6 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`)
  let checks = 0
  const expect = (condition, label) => { assert.ok(condition, label); checks += 1 }
  const query = async (sql, params = []) => (await db.query(sql, params)).rows
  const scalar = async (sql, params = []) => Object.values((await query(sql, params))[0])[0]
  const reject = async (label, sql, params = [], code) => {
    await db.exec('begin')
    let failure
    try { await db.query(sql, params) } catch (error) { failure = error }
    finally { await db.exec('rollback') }
    assert.ok(failure, `Expected rejection: ${label}`)
    if (code) assert.equal(failure.code, code, `${label}: ${failure.message}`)
    checks += 1
  }
  const actor = async (id) => {
    await db.exec('reset role')
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id ?? ''])
    await db.exec('set role authenticated')
  }
  const jobId = '10000000-0000-4000-8000-000000000001'
  const tokenA = '20000000-0000-4000-8000-000000000001'
  const tokenB = '20000000-0000-4000-8000-000000000002'
  const tokenC = '20000000-0000-4000-8000-000000000003'
  const updateSql = 'select public.update_job($1,$2,$3,$4::jsonb)'
  const jobRow = async (id = jobId) => (await query('select * from public.jobs where id=$1', [id]))[0]
  const update = (id, token, version, patch) => db.query(updateSql, [id, token, version, JSON.stringify(patch)])

  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create schema auth;
      create schema storage;
      create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb, created_at timestamptz default now());
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner_id text);
      create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1)-1] $$;
      alter table storage.objects enable row level security;
      grant usage on schema public, auth, storage to anon, authenticated, service_role;
      grant execute on function auth.uid() to anon, authenticated, service_role;
      grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
    `)
    await db.exec(schema)
    checks += 1
    for (let index = 0; index < 5; index++) await db.query('insert into auth.users(id,email) values($1,$2)', [users[index], `worker${index + 1}@example.com`])

    // Simulate the previous schema, then exercise the migration with real rows.
    await db.exec('alter table public.jobs drop column measured_by, drop column cutting_by, drop column cut_by, drop column installed_by, drop column thickness_mm, drop column responsible_name, drop column photo_paths')
    await db.exec(schema)
    checks += 1
    expect(await scalar("select count(*)::int from information_schema.columns where table_schema='public' and table_name='jobs' and column_name in ('measured_by','cutting_by','cut_by','installed_by')") === 4, 'older schema receives all four author columns')
    expect(await scalar("select count(*)::int from information_schema.columns where table_schema='public' and table_name='jobs' and column_name='thickness_mm' and is_nullable='YES'") === 1, 'older schema receives nullable thickness')
    expect(await scalar("select count(*)::int from information_schema.columns where table_schema='public' and table_name='jobs' and column_name='responsible_name' and is_nullable='NO'") === 1, 'older schema receives nonnullable responsible name')
    expect(await scalar("select count(*)::int from information_schema.columns where table_schema='public' and table_name='jobs' and column_name='photo_paths' and is_nullable='NO'") === 1, 'older schema receives nonnullable photo array')
    expect(await scalar('select count(*)::int from public.profiles') === 5, 'schema rerun does not duplicate profiles')
    expect(await scalar('select count(*)::int from public.profiles where active and member_slot is not null') === 5, 'five active unique slots')
    expect(await scalar('select role from public.profiles where id=$1', [users[0]]) === 'admin', 'first member is admin')
    await reject('sixth member blocked', 'insert into auth.users(id,email) values($1,$2)', [users[5], 'worker6@example.com'], '23514')
    expect(await scalar('select count(*)::int from auth.users') === 5, 'failed sixth signup leaves no Auth row')

    await actor(users[0])
    await db.query('insert into public.jobs(id,store_name,width_cm,length_cm,created_by,updated_by,measured_by,cutting_by,cut_by,installed_by) values($1,$2,$3,$4,$5,$5,$5,$5,$5,$5)', [jobId, '  Tienda Prado  ', 80.5, 120, users[2]])
    await db.exec('reset role; alter table public.jobs drop column thickness_mm, drop column responsible_name')
    await db.exec(thicknessMigration)
    await db.exec(thicknessMigration)
    await db.exec(responsibleMigration)
    await db.exec(responsibleMigration)
    await db.exec(workflowMigration)
    await db.exec(workflowMigration)
    await db.exec(photosMigration)
    await db.exec(photosMigration)
    await actor(users[0])
    const job = await jobRow()
    expect(job.thickness_mm === null && job.width_cm === '80.50', 'incremental migration preserves existing measurement and gives unknown thickness')
    expect(job.responsible_name === '', 'incremental responsible migration defaults existing work to unassigned')
    expect(await scalar("select count(*)::int from pg_catalog.pg_constraint where conrelid='public.jobs'::regclass and conname='jobs_responsible_name_check'") === 1, 'repeated responsible migration keeps one named constraint')
    expect(job.store_name === 'Tienda Prado' && job.created_by === users[0] && job.status === 'measured', 'creation stamps real actor even when insert forges author')
    expect(job.measured_by === users[0] && job.cutting_by === null && job.cut_by === null && job.installed_by === null, 'creation stamps only measuring author')
    await reject('zero measurement rejected', 'insert into public.jobs(store_name,width_cm,length_cm) values($1,0,100)', ['Invalid'], '23514')
    await reject('negative measurement rejected', 'insert into public.jobs(store_name,width_cm,length_cm) values($1,-1,100)', ['Invalid'], '23514')
    await reject('multiple felpudos must be separate tasks', 'insert into public.jobs(store_name,width_cm,length_cm,quantity) values($1,80,100,2)', ['Invalid'], '23514')
    await reject('unsupported thickness rejected on insert', 'insert into public.jobs(store_name,width_cm,length_cm,thickness_mm) values($1,80,100,18)', ['Invalid'], '23514')
    await reject('responsible name over 100 characters rejected on insert', 'insert into public.jobs(store_name,width_cm,length_cm,responsible_name) values($1,80,100,$2)', ['Invalid', 'x'.repeat(101)], '23514')
    await reject('null responsible name rejected on insert', 'insert into public.jobs(store_name,width_cm,length_cm,responsible_name) values($1,80,100,null)', ['Invalid'], '23502')
    const responsibleFixture = await query('insert into public.jobs(store_name,width_cm,length_cm,responsible_name) values($1,80,100,$2) returning responsible_name', ['Assignment trim fixture', '  Worker Example  '])
    expect(responsibleFixture[0].responsible_name === 'Worker Example', 'creation trims responsible name')
    const blankFixture = await query('insert into public.jobs(store_name,width_cm,length_cm,responsible_name) values($1,80,100,$2) returning responsible_name', ['Assignment empty fixture', '   '])
    expect(blankFixture[0].responsible_name === '', 'blank assignment remains a valid unassigned value')
    const boundaryFixture = await query('insert into public.jobs(store_name,width_cm,length_cm,responsible_name) values($1,80,100,$2) returning responsible_name', ['Assignment boundary fixture', `  ${'x'.repeat(100)}  `])
    expect(boundaryFixture[0].responsible_name.length === 100, '100 characters remain valid after trimming')
    await reject('installed insert rejected', "insert into public.jobs(store_name,width_cm,length_cm,status) values('Invalid',80,100,'installed')", [], '23514')
    await reject('member cannot promote own role', "update public.profiles set role='admin' where id=$1", [users[0]], '42501')

    expect(await scalar('select public.acquire_job_lock($1,$2)', [jobId, tokenA]) === true, 'first editor acquires lock')
    expect(await scalar('select public.acquire_job_lock($1,$2)', [jobId, tokenA]) === true, 'same token renews lease')
    await reject('lock tokens hidden from table query', 'select * from public.job_locks', [], '42501')
    expect((await query('select job_id,user_id,expires_at from public.job_locks')).length === 1, 'safe lock metadata readable')
    await reject('unsupported RPC fields rejected', updateSql, [jobId, tokenA, job.version, JSON.stringify({ created_by: users[1] })], '22023')
    await reject('direct REST update forbidden', "update public.jobs set notes='Bypass' where id=$1", [jobId], '42501')
    await reject('direct responsible assignment update forbidden', "update public.jobs set responsible_name='Bypass' where id=$1", [jobId], '42501')
    await reject('direct admin REST deletion forbidden', 'delete from public.jobs where id=$1', [jobId], '42501')
    await actor(users[1])
    expect(await scalar('select public.acquire_job_lock($1,$2)', [jobId, tokenB]) === false, 'second member blocked from active lock')
    await db.query('select public.release_job_lock($1,$2)', [jobId, tokenA])
    expect(await scalar('select public.acquire_job_lock($1,$2)', [jobId, tokenB]) === false, 'another member cannot release first token')
    await reject('second member cannot update using first token', updateSql, [jobId, tokenA, job.version, '{"notes":"Bypass"}'], '55P03')
    await reject('second member cannot assign responsible using first token', updateSql, [jobId, tokenA, job.version, '{"responsible_name":"Bypass"}'], '55P03')
    await actor(users[0])
    await reject('wrong token rejected', updateSql, [jobId, tokenB, job.version, '{"notes":"Bypass"}'], '55P03')
    await reject('stale version rejected', updateSql, [jobId, tokenA, -1, '{"notes":"Bypass"}'], '40001')
    await update(jobId, tokenA, job.version, { notes: 'Edited successfully', responsible_name: '  Worker Alpha  ' })
    let current = await jobRow()
    expect(current.notes === 'Edited successfully' && current.version > job.version, 'RPC updates and increments version')
    expect(current.responsible_name === 'Worker Alpha', 'RPC assignment uses valid lease and trims the name')
    await reject('too long responsible name rejected by RPC', updateSql, [jobId, tokenA, current.version, JSON.stringify({ responsible_name: 'x'.repeat(101) })], '23514')
    await reject('null responsible name rejected by RPC', updateSql, [jobId, tokenA, current.version, '{"responsible_name":null}'], '23502')
    expect(current.thickness_mm === null, 'omitted thickness patch preserves unknown')
    await update(jobId, tokenA, current.version, { thickness_mm: 20 })
    current = await jobRow()
    expect(current.thickness_mm === 20, 'RPC stores 20 mm')
    expect(current.responsible_name === 'Worker Alpha', 'omitted responsible patch preserves assignment')
    await update(jobId, tokenA, current.version, { thickness_mm: 17 })
    current = await jobRow()
    expect(current.thickness_mm === 17, 'RPC stores 17 mm')
    await reject('unsupported thickness rejected by RPC', updateSql, [jobId, tokenA, current.version, '{"thickness_mm":18}'], '23514')
    await update(jobId, tokenA, current.version, { thickness_mm: null })
    current = await jobRow()
    expect(current.thickness_mm === null, 'explicit null patch restores No sé')

    await reject('removed cutting state is rejected', updateSql, [jobId, tokenA, current.version, '{"status":"cutting"}'], '23514')
    await reject('cannot skip measured to installed', updateSql, [jobId, tokenA, current.version, '{"status":"installed"}'], '23514')
    await db.query('select public.release_job_lock($1,$2)', [jobId, tokenA])
    await actor(users[2])
    expect(await scalar('select public.acquire_job_lock($1,$2)', [jobId, tokenC]) === true, 'new measuring worker acquires')
    await update(jobId, tokenC, current.version, { width_cm: 81.5, length_cm: 123, quantity: 1, material: 'Coco gris', thickness_mm: 20 })
    current = await jobRow()
    expect(current.status === 'measured' && Number(current.width_cm) === 81.5 && Number(current.length_cm) === 123 && current.quantity === 1 && current.material === 'Coco gris', 'dimension corrections keep one measured felpudo')
    expect(current.measured_by === users[2] && current.cutting_by === null, 'edited measurement records actual worker without removed intermediate stage')
    expect(current.thickness_mm === 20, 'thickness correction succeeds while measured')
    await update(jobId, tokenC, current.version, { responsible_name: '  Worker Beta  ' })
    current = await jobRow()
    expect(current.responsible_name === 'Worker Beta' && current.status === 'measured' && current.measured_by === users[2], 'assignment can change without changing measurement author')
    await reject('RPC cannot combine two felpudos', updateSql, [jobId, tokenC, current.version, '{"quantity":2}'], '23514')
    await reject('cannot forge stage author', updateSql, [jobId, tokenC, current.version, JSON.stringify({ cut_by: users[0] })], '22023')
    await db.query('select public.release_job_lock($1,$2)', [jobId, tokenC])
    await actor(users[1])
    expect(await scalar('select public.acquire_job_lock($1,$2)', [jobId, tokenB]) === true, 'cutting worker acquires')
    await update(jobId, tokenB, current.version, { status: 'cut' })
    current = await jobRow()
    expect(current.status === 'cut' && current.cut_at !== null, 'mark cut records date')
    expect(current.cut_by === users[1] && current.measured_by === users[2] && current.cutting_by === null, 'direct measured to cut records cutting worker separately from measuring worker')
    await reject('removed cutting state cannot return after cutting', updateSql, [jobId, tokenB, current.version, '{"status":"cutting"}'], '23514')
    await update(jobId, tokenB, current.version, { responsible_name: '   ' })
    current = await jobRow()
    expect(current.responsible_name === '' && current.status === 'cut' && current.cut_by === users[1], 'assignment can be cleared before installation without changing cut author')
    await db.query('select public.release_job_lock($1,$2)', [jobId, tokenB])
    await actor(users[0])
    expect(await scalar('select public.acquire_job_lock($1,$2)', [jobId, tokenA]) === true, 'installing worker acquires')
    await reject('cut measurements immutable', updateSql, [jobId, tokenA, current.version, '{"width_cm":90}'], '23514')
    await reject('cut thickness immutable', updateSql, [jobId, tokenA, current.version, '{"thickness_mm":null}'], '23514')
    await reject('install requires photo', updateSql, [jobId, tokenA, current.version, '{"status":"installed"}'], '23514')
    await reject('install rejects nonexistent photo', updateSql, [jobId, tokenA, current.version, JSON.stringify({ status: 'installed', photo_path: `${jobId}/30000000-0000-4000-8000-000000000002.jpg` })], '23514')
    const photoPath = `${jobId}/30000000-0000-4000-8000-000000000001.jpg`
    await db.query('insert into storage.objects(bucket_id,name,owner_id) values($1,$2,$3)', ['job-photos', photoPath, users[0]])
    await update(jobId, tokenA, current.version, { status: 'installed', photo_path: photoPath })
    current = await jobRow()
    expect(current.status === 'installed' && current.photo_path === photoPath && current.installed_at !== null, 'uploaded proof completes job')
    expect(current.photo_paths.length === 1 && current.photo_paths[0] === photoPath, 'legacy single-photo RPC also creates photo array')
    expect(current.installed_by === users[0] && current.cut_by === users[1] && current.measured_by === users[2], 'installation keeps all distinct authors')
    await db.query('delete from storage.objects where name=$1', [photoPath])
    expect(await scalar('select count(*)::int from storage.objects where name=$1', [photoPath]) === 1, 'referenced photo deletion blocked')

    // A live installed legacy row must survive backfill without changing its
    // dates, authors, optimistic version or editing lease.
    const legacyInstalled = await jobRow()
    const legacyLease = await query('select job_id,user_id,expires_at from public.job_locks where job_id=$1', [jobId])
    await db.exec('reset role; alter table public.jobs drop column photo_paths')
    await db.exec(photosMigration)
    await db.exec(photosMigration)
    await actor(users[0])
    assert.deepEqual(await jobRow(), legacyInstalled, 'repeated migration backfills old installed photo without changing any existing job data')
    checks += 1
    assert.deepEqual(await query('select job_id,user_id,expires_at from public.job_locks where job_id=$1', [jobId]), legacyLease, 'photo migration preserves active editing lease')
    checks += 1

    const extraPhoto = `${jobId}/30000000-0000-4000-8000-000000000003.png`
    const thirdPhoto = `${jobId}/30000000-0000-4000-8000-000000000004.webp`
    const replacementPhoto = `${jobId}/30000000-0000-4000-8000-000000000005.jpg`
    const missingPhoto = `${jobId}/30000000-0000-4000-8000-000000000006.jpg`
    for (const path of [extraPhoto, thirdPhoto, replacementPhoto]) {
      await db.query('insert into storage.objects(bucket_id,name,owner_id) values($1,$2,$3)', ['job-photos', path, users[0]])
    }
    const photoPatchReject = (label, photo_paths, code = '23514') => reject(label, updateSql, [jobId, tokenA, current.version, JSON.stringify({ photo_paths })], code)
    await photoPatchReject('installed job cannot remove every photo', [])
    await photoPatchReject('photo array cannot be null', null, '22023')
    await photoPatchReject('photo array cannot be an object', { path: photoPath }, '22023')
    await photoPatchReject('photo array elements must be strings', [photoPath, 42], '22023')
    await photoPatchReject('photo array cannot contain null elements', [photoPath, null], '22023')
    await photoPatchReject('photo array cannot contain nested arrays', [photoPath, [extraPhoto]], '22023')
    await photoPatchReject('duplicate attached photos rejected', [photoPath, photoPath])
    await photoPatchReject('every attached photo must exist, including second photo', [photoPath, missingPhoto])
    await photoPatchReject('second photo cannot point at another job', [photoPath, extraPhoto.replace(jobId, '10000000-0000-4000-8000-000000000099')])
    await photoPatchReject('second photo cannot have invalid extension', [photoPath, extraPhoto.replace('.png', '.gif')])
    await photoPatchReject('blank photo path rejected', [photoPath, ''])
    await reject('legacy and array fields must agree', updateSql, [jobId, tokenA, current.version, JSON.stringify({ photo_paths: [photoPath, extraPhoto], photo_path: thirdPhoto })], '22023')
    await reject('multiple photos still require correct lease', updateSql, [jobId, tokenB, current.version, JSON.stringify({ photo_paths: [photoPath, extraPhoto] })], '55P03')
    await reject('multiple photos still require current version', updateSql, [jobId, tokenA, current.version - 1, JSON.stringify({ photo_paths: [photoPath, extraPhoto] })], '40001')
    assert.deepEqual(await jobRow(), legacyInstalled, 'failed photo updates leave all existing data unchanged')
    checks += 1

    await update(jobId, tokenA, current.version, { photo_paths: [photoPath, extraPhoto, thirdPhoto] })
    current = await jobRow()
    assert.deepEqual(current.photo_paths, [photoPath, extraPhoto, thirdPhoto], 'all uploaded photos are retained in order')
    checks += 1
    expect(current.photo_path === photoPath && current.status === 'installed' && Number(current.installed_at) === Number(legacyInstalled.installed_at) && current.installed_by === legacyInstalled.installed_by, 'adding more photos preserves primary photo and original completion audit')
    for (const path of [extraPhoto, thirdPhoto]) {
      await db.query('delete from storage.objects where name=$1', [path])
      expect(await scalar('select count(*)::int from storage.objects where name=$1', [path]) === 1, 'additional attached photo deletion blocked')
    }
    const multiInstalled = await jobRow()
    await db.exec('reset role')
    await db.exec(photosMigration)
    await db.exec(photosMigration)
    await db.exec(schema)
    await actor(users[0])
    assert.deepEqual(await jobRow(), multiInstalled, 'full schema and repeated migration preserve multiple photos, version and completion audit')
    checks += 1
    await update(jobId, tokenA, current.version, { notes: 'Keep every completed photo' })
    current = await jobRow()
    assert.deepEqual(current.photo_paths, [photoPath, extraPhoto, thirdPhoto], 'ordinary update preserves all photos when omitted')
    checks += 1
    await update(jobId, tokenA, current.version, { photo_path: replacementPhoto })
    current = await jobRow()
    assert.deepEqual(current.photo_paths, [replacementPhoto, extraPhoto, thirdPhoto], 'old client replacing primary photo preserves additional photos')
    checks += 1
    await update(jobId, tokenA, current.version, { photo_path: photoPath })
    current = await jobRow()
    expect(current.photo_paths.length === 3 && current.photo_path === photoPath, 'legacy primary can be restored without losing additional photos')
    await db.query('delete from storage.objects where name=$1', [replacementPhoto])
    expect(await scalar('select count(*)::int from storage.objects where name=$1', [replacementPhoto]) === 0, 'unreferenced uploaded photo can still be cleaned up')
    await reject('installed job cannot rewind', updateSql, [jobId, tokenA, current.version, '{"status":"measured"}'], '23514')
    await db.query('select public.release_job_lock($1,$2)', [jobId, tokenA])
    await actor(users[1])
    expect(await scalar('select public.acquire_job_lock($1,$2)', [jobId, tokenB]) === true, 'release lets another member acquire')

    await db.exec('reset role')
    await db.query("update public.job_locks set expires_at=clock_timestamp()-interval '1 second' where job_id=$1", [jobId])
    await actor(users[1])
    await reject('expired lease cannot save', updateSql, [jobId, tokenB, current.version, '{"notes":"Late save"}'], '55P03')
    await actor(users[0])
    expect(await scalar('select public.acquire_job_lock($1,$2)', [jobId, tokenA]) === true, 'expired lease can be claimed by another member')
    await actor(users[1])
    await reject('old token cannot save after takeover', updateSql, [jobId, tokenB, current.version, '{"notes":"Stale save"}'], '55P03')

    await actor(users[0])
    const resetId = '10000000-0000-4000-8000-000000000002'
    await db.query("insert into public.jobs(id,store_name,width_cm,length_cm) values($1,'Remeasuring',70,100)", [resetId])
    await db.query('select public.acquire_job_lock($1,$2)', [resetId, tokenA])
    await update(resetId, tokenA, 1, { status: 'cut' })
    await update(resetId, tokenA, 2, { status: 'measured', width_cm: 75, thickness_mm: 17 })
    const resetJob = await jobRow(resetId)
    expect(resetJob.status === 'measured' && Number(resetJob.width_cm) === 75 && resetJob.measured_by === users[0], 'cut job can be remeasured with revised dimensions')
    expect(resetJob.thickness_mm === 17, 'remeasuring permits corrected thickness')
    expect(resetJob.cutting_at === null && resetJob.cut_at === null && resetJob.installed_at === null && resetJob.cutting_by === null && resetJob.cut_by === null && resetJob.installed_by === null, 'remeasuring clears downstream dates and authors')

    const atomicId = '10000000-0000-4000-8000-000000000003'
    await db.query("insert into public.jobs(id,store_name,width_cm,length_cm) values($1,'Atomic cut',70,100)", [atomicId])
    await db.query('select public.acquire_job_lock($1,$2)', [atomicId, tokenA])
    await update(atomicId, tokenA, 1, { status: 'cut', width_cm: 76, thickness_mm: 20 })
    const atomicJob = await jobRow(atomicId)
    expect(atomicJob.status === 'cut' && Number(atomicJob.width_cm) === 76 && atomicJob.thickness_mm === 20, 'corrected measurement and direct mark cut are atomic')
    expect(atomicJob.measured_by === users[0] && atomicJob.cut_by === users[0] && atomicJob.cutting_at === null, 'atomic mark cut records both real authors without intermediate stage')
    const atomicPhotos = [
      `${atomicId}/30000000-0000-4000-8000-000000000001.jpg`,
      `${atomicId}/30000000-0000-4000-8000-000000000002.png`,
    ]
    await db.query('insert into storage.objects(bucket_id,name,owner_id) values($1,$2,$3)', ['job-photos', atomicPhotos[0], users[0]])
    await reject('initial placement verifies every selected photo atomically', updateSql, [atomicId, tokenA, atomicJob.version, JSON.stringify({ status: 'installed', photo_paths: atomicPhotos })], '23514')
    expect((await jobRow(atomicId)).status === 'cut' && (await jobRow(atomicId)).version === atomicJob.version, 'failed multiple-photo placement keeps original cut state and version')
    await db.query('insert into storage.objects(bucket_id,name,owner_id) values($1,$2,$3)', ['job-photos', atomicPhotos[1], users[0]])
    await update(atomicId, tokenA, atomicJob.version, { status: 'installed', photo_paths: atomicPhotos })
    const installedWithTwo = await jobRow(atomicId)
    expect(installedWithTwo.status === 'installed' && installedWithTwo.photo_paths.length === 2 && installedWithTwo.photo_path === atomicPhotos[0] && installedWithTwo.installed_by === users[0], 'initial placement saves multiple uploaded photos and real installer in one transaction')

    // Simulate older live data. Migration must separate real quantities and
    // collapse the removed stage, rather than silently dropping a felpudo.
    await db.exec(`reset role;
      alter table public.jobs drop constraint jobs_quantity_check;
      alter table public.jobs add constraint jobs_quantity_check check (quantity between 1 and 100);
      alter table public.jobs drop constraint jobs_status_check;
      alter table public.jobs add constraint jobs_status_check check (status in ('measured','cutting','cut','installed'));
      alter table public.jobs disable trigger jobs_prepare;
    `)
    const legacyCuttingId = '10000000-0000-4000-8000-000000000004'
    const legacyCutId = '10000000-0000-4000-8000-000000000005'
    const baselineCount = await scalar('select count(*)::int from public.jobs')
    await db.query(`insert into public.jobs(id,store_name,width_cm,length_cm,quantity,thickness_mm,material,responsible_name,notes,status,measured_by,cutting_at,cutting_by)
      values($1,'Legacy cutting',50.25,100.5,2,20,'coco','Nicole','Notas originales','cutting',$2,now(),$3)`, [legacyCuttingId, users[2], users[1]])
    await db.query(`insert into public.jobs(id,store_name,width_cm,length_cm,quantity,thickness_mm,material,responsible_name,notes,status,measured_by,cut_at,cut_by)
      values($1,'Legacy cut',60.25,110.5,3,17,'coco','Andrés','No eliminar','cut',$2,now(),$3)`, [legacyCutId, users[2], users[1]])
    await db.query('update public.jobs set quantity=2 where id=$1', [jobId])
    let ambiguousPhotoFailure
    try { await db.exec(workflowMigration) } catch (error) { ambiguousPhotoFailure = error }
    finally { await db.exec('rollback') }
    expect(ambiguousPhotoFailure?.code === '23514', 'migration refuses to assign one final photo to separate installed felpudos')
    expect(await scalar('select quantity from public.jobs where id=$1', [legacyCutId]) === 3, 'rejected migration rolls back instead of partially splitting data')
    await db.query('update public.jobs set quantity=1 where id=$1', [jobId])
    await db.exec(workflowMigration)
    await db.exec(workflowMigration)
    expect(await scalar('select count(*)::int from public.jobs') === baselineCount + 5, 'quantities 2 and 3 produce exactly five separate tasks after repeated migration')
    const migratedCutting = await query("select * from public.jobs where store_name like 'Legacy cutting%' order by store_name")
    expect(migratedCutting.length === 2 && migratedCutting.every(row => row.quantity === 1 && row.status === 'measured' && row.cutting_at === null && row.cutting_by === null), 'two previously cutting felpudos return to measured individually')
    expect(migratedCutting.every(row => Number(row.width_cm) === 50.25 && Number(row.length_cm) === 100.5 && row.thickness_mm === 20 && row.material === 'coco' && row.responsible_name === 'Nicole' && row.notes === 'Notas originales' && row.measured_by === users[2]), 'separation preserves measurements, material, responsible, notes and real measuring author')
    const migratedCut = await query("select * from public.jobs where store_name like 'Legacy cut · felpudo %' order by store_name")
    expect(migratedCut.length === 3 && migratedCut.every(row => row.quantity === 1 && row.status === 'cut' && row.cut_by === users[1] && row.cut_at !== null && row.notes === 'No eliminar'), 'already cut felpudos remain cut after individual separation')
    expect(await scalar('select photo_path from public.jobs where id=$1', [jobId]) === photoPath, 'migration keeps installed final photo')
    await actor(users[0])
    await reject('new migration keeps direct updates forbidden', "update public.jobs set status='installed' where id=$1", [legacyCutId], '42501')
    await reject('new migration rejects removed stage on insert', "insert into public.jobs(store_name,width_cm,length_cm,status) values('Old client',80,100,'cutting')", [], '23514')
    await db.exec('reset role')
    await db.exec(schema)
    expect(await scalar('select count(*)::int from public.jobs') === baselineCount + 5, 'full schema rerun does not duplicate separated tasks')

    // Existing work and its leases survive the additive type/review migration.
    const beforeTypes = await jobRow()
    const beforeTypesLease = await query('select job_id,user_id,expires_at from public.job_locks where job_id=$1', [jobId])
    await db.exec(typesMigration)
    await db.exec(typesMigration)
    assert.deepEqual(await jobRow(), beforeTypes, 'repeated type migration preserves all existing job data')
    assert.deepEqual(await query('select job_id,user_id,expires_at from public.job_locks where job_id=$1', [jobId]), beforeTypesLease, 'type migration preserves editing lease')
    checks += 2
    await actor(users[0])
    const unmeasuredId = '10000000-0000-4000-8000-000000000006'
    await db.query("insert into public.jobs(id,store_name,status,review_status,revision_no,review_notes,reviewed_by) values($1,'New unmeasured mat','pending_measurement','approved',8,'Forged',$2)", [unmeasuredId, users[1]])
    let unmeasured = await jobRow(unmeasuredId)
    expect(unmeasured.job_kind === 'mat' && unmeasured.width_cm === null && unmeasured.length_cm === null && unmeasured.measured_at === null && unmeasured.measured_by === null, 'new mat can be registered before measuring without inventing dates')
    expect(unmeasured.review_status === 'pending' && unmeasured.revision_no === 0 && unmeasured.review_notes === '' && unmeasured.reviewed_by === null, 'insert cannot forge review metadata')
    await db.query('select public.acquire_job_lock($1,$2)', [unmeasuredId, tokenA])
    await reject('unmeasured mat cannot claim measured without dimensions', updateSql, [unmeasuredId, tokenA, unmeasured.version, '{"status":"measured"}'], '23514')
    await reject('unmeasured mat cannot skip cutting', updateSql, [unmeasuredId, tokenA, unmeasured.version, '{"status":"cut","width_cm":80,"length_cm":100}'], '23514')
    await reject('partial dimensions are not a measurement', updateSql, [unmeasuredId, tokenA, unmeasured.version, '{"width_cm":80}'], '23514')
    await update(unmeasuredId, tokenA, unmeasured.version, { status: 'measured', width_cm: 80, length_cm: 100 })
    unmeasured = await jobRow(unmeasuredId)
    expect(unmeasured.status === 'measured' && unmeasured.measured_at !== null && unmeasured.measured_by === users[0], 'measuring new mat records real measurement actor and date')

    const deviceId = '10000000-0000-4000-8000-000000000007'
    await db.query("insert into public.jobs(id,store_name,job_kind,status,quantity) values($1,'Local devices','dehumidifier','pending_installation',4)", [deviceId])
    let device = await jobRow(deviceId)
    expect(device.quantity === 4 && device.width_cm === null && device.length_cm === null && device.measured_at === null && device.measured_by === null, 'device stores needed units without dimensions or measurement audit')
    await reject('device cannot start measured', "insert into public.jobs(store_name,job_kind,status,quantity) values('Invalid','dehumidifier','measured',2)", [], '23514')
    await reject('device cannot have zero units', "insert into public.jobs(store_name,job_kind,status,quantity) values('Invalid','dehumidifier','pending_installation',0)", [], '23514')
    await reject('device cannot have mat dimensions', "insert into public.jobs(store_name,job_kind,status,width_cm,length_cm) values('Invalid','dehumidifier','pending_installation',80,100)", [], '23514')
    await reject('mat cannot use device workflow', "insert into public.jobs(store_name,status,width_cm,length_cm) values('Invalid','pending_installation',80,100)", [], '23514')
    await db.query('select public.acquire_job_lock($1,$2)', [deviceId, tokenA])
    await update(deviceId, tokenA, device.version, { quantity: 5 })
    device = await jobRow(deviceId)
    expect(device.quantity === 5 && device.status === 'pending_installation', 'pending device quantity can be corrected with lease and version')
    await reject('device cannot be cut', updateSql, [deviceId, tokenA, device.version, '{"status":"cut"}'], '23514')
    await reject('device placement needs at least one photo', updateSql, [deviceId, tokenA, device.version, '{"status":"installed"}'], '23514')
    const devicePhoto = `${deviceId}/30000000-0000-4000-8000-000000000001.jpg`
    await db.query('insert into storage.objects(bucket_id,name,owner_id) values($1,$2,$3)', ['job-photos', devicePhoto, users[0]])
    await update(deviceId, tokenA, device.version, { status: 'installed', photo_paths: [devicePhoto] })
    device = await jobRow(deviceId)
    expect(device.status === 'installed' && device.quantity === 5 && device.installed_by === users[0] && device.measured_at === null && device.cut_at === null, 'device places directly from pending with units and photo')
    await reject('placed device quantity cannot change', updateSql, [deviceId, tokenA, device.version, '{"quantity":6}'], '23514')
    const reviewSql = 'select public.review_job($1,$2,$3,$4,$5)'
    const review = (id, token, version, action, notes = '') => db.query(reviewSql, [id, token, version, action, notes])
    await reject('mat review does not apply to devices', reviewSql, [deviceId, tokenA, device.version, 'approve', ''], '23514')
    await reject('normal update cannot change work type', updateSql, [deviceId, tokenA, device.version, '{"job_kind":"mat"}'], '22023')

    current = await jobRow()
    await db.query('select public.acquire_job_lock($1,$2)', [jobId, tokenA])
    await reject('review requires correct token', reviewSql, [jobId, tokenB, current.version, 'approve', ''], '55P03')
    await reject('review requires current version', reviewSql, [jobId, tokenA, current.version - 1, 'approve', ''], '40001')
    await reject('review action must be defined', reviewSql, [jobId, tokenA, current.version, 'other', ''], '22023')
    await reject('rework explanation is required', reviewSql, [jobId, tokenA, current.version, 'replace', '  '], '22023')
    await reject('cannot forge review status in normal update', updateSql, [jobId, tokenA, current.version, '{"review_status":"approved"}'], '22023')
    await reject('cannot forge revision number in normal update', updateSql, [jobId, tokenA, current.version, '{"revision_no":9}'], '22023')
    await reject('client cannot write historical events', "insert into public.job_events(job_id,revision_no,event_type,snapshot) values($1,1,'rework_started','{}')", [jobId], '42501')
    await reject('client cannot forge internal review authorization', 'insert into private.job_review_context(job_id,transaction_id,actor_id,expected_version,action) values($1,txid_current(),$2,$3,$4)', [jobId, users[0], current.version, 'replace'], '42501')
    const beforeApproval = current
    await review(jobId, tokenA, current.version, 'approve', 'Inspección correcta')
    current = await jobRow()
    expect(current.review_status === 'approved' && current.reviewed_by === users[0] && current.revision_no === 0, 'inspection approval records reviewer without opening a revision')
    expect(current.status === 'installed' && current.width_cm === beforeApproval.width_cm && Number(current.installed_at) === Number(beforeApproval.installed_at) && current.installed_by === beforeApproval.installed_by, 'approval preserves dimensions, status and completion audit')
    assert.deepEqual(current.photo_paths, beforeApproval.photo_paths, 'approval preserves every completion photo')
    checks += 1
    const approvalEvent = (await query("select * from public.job_events where job_id=$1 and event_type='review_approved'", [jobId]))[0]
    expect(approvalEvent.actor_id === users[0] && approvalEvent.snapshot.version === beforeApproval.version && approvalEvent.snapshot.review_status === 'pending', 'approval event stores original complete job snapshot and actor')

    const beforeRework = current
    await review(jobId, tokenA, current.version, 'replace', 'Volver a medir y sustituir entero')
    current = await jobRow()
    expect(current.status === 'pending_measurement' && current.width_cm === null && current.length_cm === null && current.measured_at === null && current.cut_at === null && current.installed_at === null, 'replacement reopens measuring and clears all current phase audits')
    expect(current.photo_paths.length === 0 && current.photo_path === null && current.review_status === 'needs_adjustment' && current.rework_kind === 'replace' && current.revision_no === 1, 'replacement opens one correction cycle requiring new proof')
    expect(current.notes === beforeRework.notes && current.material === beforeRework.material && current.thickness_mm === beforeRework.thickness_mm && current.responsible_name === beforeRework.responsible_name, 'reopening preserves operational notes, material, thickness and assignment')
    const reworkEvent = (await query("select * from public.job_events where job_id=$1 and event_type='rework_started'", [jobId]))[0]
    expect(reworkEvent.revision_no === 1 && reworkEvent.snapshot.revision_no === 0 && Number(reworkEvent.snapshot.width_cm) === Number(beforeRework.width_cm) && reworkEvent.snapshot.installed_by === beforeRework.installed_by, 'correction event keeps original dimensions and completion audit in previous snapshot')
    assert.deepEqual(reworkEvent.snapshot.photo_paths, beforeRework.photo_paths, 'reopening archives every previous photo')
    checks += 1
    for (const path of beforeRework.photo_paths) {
      await db.query('delete from storage.objects where name=$1', [path])
      expect(await scalar('select count(*)::int from storage.objects where name=$1', [path]) === 1, 'historical photo remains protected after clearing current photo list')
    }
    await reject('rework cannot jump straight to cut', updateSql, [jobId, tokenA, current.version, '{"status":"cut","width_cm":82,"length_cm":124}'], '23514')
    await reject('historical photo cannot count as new correction proof', updateSql, [jobId, tokenA, current.version, JSON.stringify({ photo_paths: [photoPath] })], '23514')
    await update(jobId, tokenA, current.version, { status: 'measured', width_cm: 82, length_cm: 124 })
    current = await jobRow()
    await update(jobId, tokenA, current.version, { status: 'cut' })
    current = await jobRow()
    await reject('correction completion still needs photo', updateSql, [jobId, tokenA, current.version, '{"status":"installed"}'], '23514')
    const correctionPhoto = `${jobId}/30000000-0000-4000-8000-000000000007.jpg`
    await db.query('insert into storage.objects(bucket_id,name,owner_id) values($1,$2,$3)', ['job-photos', correctionPhoto, users[0]])
    await update(jobId, tokenA, current.version, { status: 'installed', photo_paths: [correctionPhoto] })
    current = await jobRow()
    expect(current.status === 'installed' && current.review_status === 'pending' && current.reviewed_at === null && current.reviewed_by === null && current.revision_no === 1 && current.rework_kind === 'replace', 'corrected placement returns to pending inspection and preserves its correction cycle')
    await review(jobId, tokenA, current.version, 'trim', 'Recortar el sobrante junto a la puerta')
    current = await jobRow()
    expect(current.status === 'pending_adjustment' && current.width_cm === '82.00' && current.length_cm === '124.00' && current.measured_by === users[0] && current.measured_at !== null, 'small trim correction retains dimensions and measurement audit')
    expect(current.cut_at === null && current.installed_at === null && current.photo_paths.length === 0 && current.revision_no === 2 && current.rework_kind === 'trim', 'trim reopens adjustment with new proof required')
    await reject('trim must not rewrite old dimensions', updateSql, [jobId, tokenA, current.version, '{"width_cm":79}'], '23514')
    await reject('trim cannot reuse previous correction photo', updateSql, [jobId, tokenA, current.version, JSON.stringify({ status: 'installed', photo_paths: [correctionPhoto] })], '23514')
    const trimPhoto = `${jobId}/30000000-0000-4000-8000-000000000008.jpg`
    await db.query('insert into storage.objects(bucket_id,name,owner_id) values($1,$2,$3)', ['job-photos', trimPhoto, users[0]])
    await update(jobId, tokenA, current.version, { status: 'installed', photo_paths: [trimPhoto] })
    current = await jobRow()
    expect(current.status === 'installed' && current.review_status === 'pending' && current.revision_no === 2 && current.cut_at === null, 'trim correction places directly after adjustment and a fresh photo')
    await review(jobId, tokenA, current.version, 'add', 'Medir la pieza que falta para añadirla')
    current = await jobRow()
    expect(current.status === 'pending_measurement' && current.rework_kind === 'add' && current.revision_no === 3 && current.width_cm === null && current.length_cm === null, 'addition opens fresh measurement without guessing new piece size')
    await db.exec('reset role')
    expect(await scalar('select count(*)::int from private.job_review_context') === 0, 'review internal authorization is consumed atomically')
    await actor(users[0])
    const historyBeforeRerun = await query('select * from public.job_events where job_id=$1 order by created_at,id', [jobId])
    const deviceBeforeRerun = await jobRow(deviceId)
    const matBeforeRerun = await jobRow()
    await db.exec('reset role')
    await db.exec(typesMigration)
    await db.exec(typesMigration)
    await db.exec(schema)
    await actor(users[0])
    assert.deepEqual(await jobRow(deviceId), deviceBeforeRerun, 'full schema rerun does not split devices or alter their unit quantity')
    assert.deepEqual(await jobRow(), matBeforeRerun, 'full schema rerun preserves reopened mat revision and missing dimensions')
    assert.deepEqual(await query('select * from public.job_events where job_id=$1 order by created_at,id', [jobId]), historyBeforeRerun, 'repeated migration and full schema preserve every history snapshot')
    checks += 3
    await reject('historical events cannot be altered', "update public.job_events set notes='Altered' where job_id=$1", [jobId], '42501')
    await reject('historical events cannot be deleted', 'delete from public.job_events where job_id=$1', [jobId], '42501')

    await db.exec('reset role')
    await db.query('update public.profiles set active=false where id=$1', [users[1]])
    await actor(users[1])
    expect(await scalar('select count(*)::int from public.jobs') === 0, 'inactive user sees no jobs')
    expect(await scalar('select count(*)::int from public.job_events') === 0, 'inactive user sees no job history')
    await reject('inactive user cannot review a placed mat', reviewSql, [jobId, tokenB, current.version, 'approve', ''], '42501')
    await reject('inactive user cannot update with former lock', updateSql, [jobId, tokenB, current.version, '{"notes":"Bypass"}'], '42501')
    await reject('inactive user cannot assign responsible', updateSql, [jobId, tokenB, current.version, '{"responsible_name":"Bypass"}'], '42501')
    await db.exec('reset role')
    await db.exec('set role anon')
    await reject('anonymous jobs read forbidden', 'select * from public.jobs', [], '42501')
    await reject('anonymous history read forbidden', 'select * from public.job_events', [], '42501')
    await reject('anonymous review forbidden', reviewSql, [jobId, tokenA, current.version, 'approve', ''], '42501')
    await reject('anonymous lock forbidden', 'select public.acquire_job_lock($1,$2)', [jobId, tokenB], '42501')
    await db.exec('reset role')
    await db.query('insert into auth.users(id,email) values($1,$2)', [users[5], 'worker6@example.com'])
    expect(await scalar('select count(*)::int from public.profiles where active') === 5, 'deactivation frees one of five slots')
    await reject('inactive member cannot reactivate above five', 'update public.profiles set active=true where id=$1', [users[1]], '23514')
    t.diagnostic(`${checks} schema checks passed using PGlite with Auth/Storage mocks; Supabase HTTP APIs and genuinely parallel transactions are not tested.`)
  } finally {
    await db.close()
  }
})
