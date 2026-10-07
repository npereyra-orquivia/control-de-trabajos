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
    await db.exec('alter table public.jobs drop column measured_by, drop column cutting_by, drop column cut_by, drop column installed_by, drop column thickness_mm, drop column responsible_name')
    await db.exec(schema)
    checks += 1
    expect(await scalar("select count(*)::int from information_schema.columns where table_schema='public' and table_name='jobs' and column_name in ('measured_by','cutting_by','cut_by','installed_by')") === 4, 'older schema receives all four author columns')
    expect(await scalar("select count(*)::int from information_schema.columns where table_schema='public' and table_name='jobs' and column_name='thickness_mm' and is_nullable='YES'") === 1, 'older schema receives nullable thickness')
    expect(await scalar("select count(*)::int from information_schema.columns where table_schema='public' and table_name='jobs' and column_name='responsible_name' and is_nullable='NO'") === 1, 'older schema receives nonnullable responsible name')
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
    await actor(users[0])
    const job = await jobRow()
    expect(job.thickness_mm === null && job.width_cm === '80.50', 'incremental migration preserves existing measurement and gives unknown thickness')
    expect(job.responsible_name === '', 'incremental responsible migration defaults existing work to unassigned')
    expect(await scalar("select count(*)::int from pg_catalog.pg_constraint where conrelid='public.jobs'::regclass and conname='jobs_responsible_name_check'") === 1, 'repeated responsible migration keeps one named constraint')
    expect(job.store_name === 'Tienda Prado' && job.created_by === users[0] && job.status === 'measured', 'creation stamps real actor even when insert forges author')
    expect(job.measured_by === users[0] && job.cutting_by === null && job.cut_by === null && job.installed_by === null, 'creation stamps only measuring author')
    await reject('zero measurement rejected', 'insert into public.jobs(store_name,width_cm,length_cm) values($1,0,100)', ['Invalid'], '23514')
    await reject('negative measurement rejected', 'insert into public.jobs(store_name,width_cm,length_cm) values($1,-1,100)', ['Invalid'], '23514')
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

    await reject('cannot skip measured to cut', updateSql, [jobId, tokenA, current.version, '{"status":"cut"}'], '23514')
    await reject('cannot skip measured to installed', updateSql, [jobId, tokenA, current.version, '{"status":"installed"}'], '23514')
    await db.query('select public.release_job_lock($1,$2)', [jobId, tokenA])
    await actor(users[2])
    expect(await scalar('select public.acquire_job_lock($1,$2)', [jobId, tokenC]) === true, 'new measuring worker acquires')
    await update(jobId, tokenC, current.version, { status: 'cutting', width_cm: 81.5, length_cm: 123, quantity: 2, material: 'Coco gris', thickness_mm: 20 })
    current = await jobRow()
    expect(current.status === 'cutting' && Number(current.width_cm) === 81.5 && Number(current.length_cm) === 123 && current.quantity === 2 && current.material === 'Coco gris', 'atomic dimension edits and start cutting succeed')
    expect(current.measured_by === users[2] && current.cutting_by === users[2], 'edited measurement and starting cut record actual worker')
    expect(current.thickness_mm === 20, 'thickness edit and start cutting are atomic')
    await update(jobId, tokenC, current.version, { responsible_name: '  Worker Beta  ' })
    current = await jobRow()
    expect(current.responsible_name === 'Worker Beta' && current.status === 'cutting' && current.measured_by === users[2], 'assignment can change while cutting without changing measurement author')
    await reject('cutting thickness immutable', updateSql, [jobId, tokenC, current.version, '{"thickness_mm":17}'], '23514')
    await reject('cannot skip cutting to installed', updateSql, [jobId, tokenC, current.version, '{"status":"installed"}'], '23514')
    await reject('cannot forge stage author', updateSql, [jobId, tokenC, current.version, JSON.stringify({ cut_by: users[0] })], '22023')
    await db.query('select public.release_job_lock($1,$2)', [jobId, tokenC])
    await actor(users[1])
    expect(await scalar('select public.acquire_job_lock($1,$2)', [jobId, tokenB]) === true, 'cutting worker acquires')
    await update(jobId, tokenB, current.version, { status: 'cut' })
    current = await jobRow()
    expect(current.status === 'cut' && current.cut_at !== null, 'mark cut records date')
    expect(current.cut_by === users[1] && current.measured_by === users[2] && current.cutting_by === users[2], 'cut author remains separate from measuring and starting worker')
    await update(jobId, tokenB, current.version, { responsible_name: '   ' })
    current = await jobRow()
    expect(current.responsible_name === '' && current.status === 'cut' && current.cut_by === users[1], 'assignment can be cleared before installation without changing cut author')
    await db.query('select public.release_job_lock($1,$2)', [jobId, tokenB])
    await actor(users[0])
    expect(await scalar('select public.acquire_job_lock($1,$2)', [jobId, tokenA]) === true, 'installing worker acquires')
    await reject('cut measurements immutable', updateSql, [jobId, tokenA, current.version, '{"width_cm":90}'], '23514')
    await reject('cut thickness immutable', updateSql, [jobId, tokenA, current.version, '{"thickness_mm":null}'], '23514')
    await reject('install requires photo', updateSql, [jobId, tokenA, current.version, '{"status":"installed"}'], '23514')
    const photoPath = `${jobId}/30000000-0000-4000-8000-000000000001.jpg`
    await db.query('insert into storage.objects(bucket_id,name,owner_id) values($1,$2,$3)', ['job-photos', photoPath, users[0]])
    await update(jobId, tokenA, current.version, { status: 'installed', photo_path: photoPath })
    current = await jobRow()
    expect(current.status === 'installed' && current.photo_path === photoPath && current.installed_at !== null, 'uploaded proof completes job')
    expect(current.installed_by === users[0] && current.cut_by === users[1] && current.measured_by === users[2], 'installation keeps all distinct authors')
    await db.query('delete from storage.objects where name=$1', [photoPath])
    expect(await scalar('select count(*)::int from storage.objects where name=$1', [photoPath]) === 1, 'referenced photo deletion blocked')
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
    await update(resetId, tokenA, 1, { status: 'cutting' })
    await update(resetId, tokenA, 2, { status: 'cut' })
    await update(resetId, tokenA, 3, { status: 'measured', width_cm: 75, thickness_mm: 17 })
    const resetJob = await jobRow(resetId)
    expect(resetJob.status === 'measured' && Number(resetJob.width_cm) === 75 && resetJob.measured_by === users[0], 'cut job can be remeasured with revised dimensions')
    expect(resetJob.thickness_mm === 17, 'remeasuring permits corrected thickness')
    expect(resetJob.cutting_at === null && resetJob.cut_at === null && resetJob.installed_at === null && resetJob.cutting_by === null && resetJob.cut_by === null && resetJob.installed_by === null, 'remeasuring clears downstream dates and authors')

    await db.exec('reset role')
    await db.query('update public.profiles set active=false where id=$1', [users[1]])
    await actor(users[1])
    expect(await scalar('select count(*)::int from public.jobs') === 0, 'inactive user sees no jobs')
    await reject('inactive user cannot update with former lock', updateSql, [jobId, tokenB, current.version, '{"notes":"Bypass"}'], '42501')
    await reject('inactive user cannot assign responsible', updateSql, [jobId, tokenB, current.version, '{"responsible_name":"Bypass"}'], '42501')
    await db.exec('reset role')
    await db.exec('set role anon')
    await reject('anonymous jobs read forbidden', 'select * from public.jobs', [], '42501')
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
