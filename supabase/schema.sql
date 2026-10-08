-- Felpudos: ejecutar completo en Supabase > SQL Editor, en un proyecto dedicado.
-- No contiene contraseñas ni claves. Habilitar el registro en Authentication.
begin;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Trabajador'
    check (char_length(btrim(display_name)) between 1 and 100),
  role text not null default 'member' check (role in ('admin', 'member')),
  active boolean not null default true,
  -- Cinco plazas únicas: la restricción respalda el bloqueo del trigger.
  member_slot smallint unique check (member_slot between 1 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_active_slot check (
    (active and member_slot is not null) or
    (not active and member_slot is null)
  )
);

create or replace function private.enforce_member_limit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(746352, 5);
  if new.active then
    if tg_op = 'INSERT' then
      new.member_slot := null;
    elsif not old.active then
      new.member_slot := null;
    else
      new.member_slot := old.member_slot;
    end if;

    if new.member_slot is null then
      select s.slot into new.member_slot
      from pg_catalog.generate_series(1, 5) as s(slot)
      where not exists (
        select 1 from public.profiles p where p.member_slot = s.slot
      )
      order by s.slot limit 1;
      if new.member_slot is null then
        raise exception 'El equipo admite un máximo de 5 usuarios activos.'
          using errcode = '23514';
      end if;
    end if;
  else
    new.member_slot := null;
  end if;
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

drop trigger if exists profiles_member_limit on public.profiles;
create trigger profiles_member_limit
before insert or update on public.profiles
for each row execute function private.enforce_member_limit();

create or replace function private.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(746352, 5);
  insert into public.profiles (id, display_name, role)
  values (
    new.id,
    left(coalesce(
      nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
      nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'Trabajador'
    ), 100),
    case when not exists (select 1 from public.profiles)
      then 'admin' else 'member' end
  );
  return new;
end;
$$;

drop trigger if exists felpudos_auth_user_created on auth.users;
create trigger felpudos_auth_user_created
after insert on auth.users
for each row execute function private.handle_new_user();

-- También cubre cuentas creadas antes de instalar el esquema. Más de cinco
-- cuentas sin perfil causan rollback; usar un proyecto dedicado a esta app.
do $$
declare existing_user record;
begin
  perform pg_catalog.pg_advisory_xact_lock(746352, 5);
  for existing_user in
    select u.id, u.email, u.raw_user_meta_data from auth.users u
    where not exists (select 1 from public.profiles p where p.id = u.id)
    order by u.created_at, u.id
  loop
    insert into public.profiles (id, display_name, role)
    values (
      existing_user.id,
      left(coalesce(
        nullif(btrim(existing_user.raw_user_meta_data ->> 'display_name'), ''),
        nullif(btrim(existing_user.raw_user_meta_data ->> 'full_name'), ''),
        nullif(split_part(coalesce(existing_user.email, ''), '@', 1), ''),
        'Trabajador'
      ), 100),
      case when not exists (select 1 from public.profiles)
        then 'admin' else 'member' end
    );
  end loop;
end;
$$;

create or replace function private.is_active_member()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and active
  );
$$;

create or replace function private.is_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and active and role = 'admin'
  );
$$;

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  store_name text not null check (char_length(btrim(store_name)) between 1 and 140),
  address text not null default '' check (char_length(address) <= 300),
  job_kind text not null default 'mat',
  width_cm numeric(8, 2) check (width_cm > 0 and width_cm <= 100000),
  length_cm numeric(8, 2) check (length_cm > 0 and length_cm <= 100000),
  quantity integer not null default 1 constraint jobs_quantity_check check (
    (job_kind = 'mat' and quantity = 1) or (job_kind = 'dehumidifier' and quantity > 0)
  ),
  thickness_mm smallint constraint jobs_thickness_mm_check
    check (thickness_mm is null or thickness_mm in (17, 20)),
  material text not null default '' check (char_length(material) <= 100),
  responsible_name text not null default '' constraint jobs_responsible_name_check
    check (char_length(btrim(responsible_name)) <= 100),
  notes text not null default '' check (char_length(notes) <= 3000),
  status text not null default 'measured'
    constraint jobs_status_check check (status in ('pending_measurement', 'measured', 'cut', 'installed', 'pending_installation', 'pending_adjustment')),
  photo_path text,
  photo_paths text[] not null default '{}'::text[],
  measured_at timestamptz default now(),
  cutting_at timestamptz,
  cut_at timestamptz,
  installed_at timestamptz,
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  measured_by uuid references auth.users(id) on delete set null,
  cutting_by uuid references auth.users(id) on delete set null,
  cut_by uuid references auth.users(id) on delete set null,
  installed_by uuid references auth.users(id) on delete set null,
  constraint jobs_photo_location check (
    photo_path is null or (
      split_part(photo_path, '/', 1) = id::text and
      photo_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|heic|heif)$'
    )
  ),
  constraint jobs_installed_photo check (
    status <> 'installed' or (cardinality(photo_paths) > 0 and installed_at is not null)
  )
);

-- Actualiza también instalaciones previas. Las etapas históricas sin autor
-- se conservan como null: no se atribuyen a un trabajador que no conocemos.
alter table public.jobs add column if not exists measured_by uuid references auth.users(id) on delete set null;
alter table public.jobs add column if not exists cutting_by uuid references auth.users(id) on delete set null;
alter table public.jobs add column if not exists cut_by uuid references auth.users(id) on delete set null;
alter table public.jobs add column if not exists installed_by uuid references auth.users(id) on delete set null;
alter table public.jobs add column if not exists thickness_mm smallint;
alter table public.jobs add column if not exists responsible_name text not null default '';
alter table public.jobs add column if not exists photo_paths text[] not null default '{}'::text[];
alter table public.jobs add column if not exists job_kind text not null default 'mat';
alter table public.jobs alter column responsible_name set default '';
alter table public.jobs alter column responsible_name set not null;
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.jobs'::regclass and conname = 'jobs_thickness_mm_check'
  ) then
    alter table public.jobs add constraint jobs_thickness_mm_check
      check (thickness_mm is null or thickness_mm in (17, 20));
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.jobs'::regclass and conname = 'jobs_responsible_name_check'
  ) then
    alter table public.jobs add constraint jobs_responsible_name_check
      check (char_length(btrim(responsible_name)) <= 100);
  end if;
end;
$$;

-- Serializa la separación con las ediciones que ya estén en curso.
lock table public.jobs in access exclusive mode;
drop trigger if exists jobs_prepare on public.jobs;

do $$
declare
  source_job public.jobs%rowtype;
  piece integer;
  piece_name text;
begin
  -- Una foto pertenece a la carpeta del identificador de un felpudo. No se
  -- atribuye una misma foto a nuevas tareas colocadas ni se inventa su prueba.
  if exists (select 1 from public.jobs where job_kind = 'mat' and quantity > 1 and status = 'installed') then
    raise exception 'Hay trabajos colocados con varias unidades. Sepáralos con su foto individual antes de actualizar.'
      using errcode = '23514';
  end if;

  for source_job in select * from public.jobs where job_kind = 'mat' and quantity > 1 order by id loop
    for piece in 2..source_job.quantity loop
      piece_name := source_job.store_name || ' · felpudo ' || piece || '/' || source_job.quantity;
      insert into public.jobs (
        store_name, address, width_cm, length_cm, quantity, thickness_mm,
        material, responsible_name, notes, status, photo_path,
        measured_at, cutting_at, cut_at, installed_at, version,
        created_at, updated_at, created_by, updated_by,
        measured_by, cutting_by, cut_by, installed_by
      ) values (
        case when char_length(piece_name) <= 140 then piece_name else source_job.store_name end,
        source_job.address, source_job.width_cm, source_job.length_cm, 1, source_job.thickness_mm,
        source_job.material, source_job.responsible_name, source_job.notes, source_job.status, null,
        source_job.measured_at, source_job.cutting_at, source_job.cut_at, source_job.installed_at, 1,
        source_job.created_at, pg_catalog.now(), source_job.created_by, null,
        source_job.measured_by, source_job.cutting_by, source_job.cut_by, source_job.installed_by
      );
    end loop;
    piece_name := source_job.store_name || ' · felpudo 1/' || source_job.quantity;
    update public.jobs set
      store_name = case when char_length(piece_name) <= 140 then piece_name else source_job.store_name end,
      quantity = 1, version = version + 1, updated_at = pg_catalog.now(), updated_by = null
    where id = source_job.id;
  end loop;
end;
$$;

-- El paso intermedio eliminado vuelve a Medido; conserva la medición y autor.
update public.jobs set
  status = 'measured', cutting_at = null, cutting_by = null,
  cut_at = null, cut_by = null, installed_at = null, installed_by = null,
  version = version + 1, updated_at = pg_catalog.now(), updated_by = null
where status = 'cutting';

alter table public.jobs drop constraint if exists jobs_quantity_check;
alter table public.jobs add constraint jobs_quantity_check check (
  (job_kind = 'mat' and quantity = 1) or (job_kind = 'dehumidifier' and quantity > 0)
);
alter table public.jobs drop constraint if exists jobs_status_check;
alter table public.jobs add constraint jobs_status_check check (status in ('pending_measurement', 'measured', 'cut', 'installed', 'pending_installation', 'pending_adjustment'));

-- La primera foto sigue disponible para clientes antiguos; el array conserva
-- todas las fotos. No cambia autores, fechas ni versiones al migrar.
update public.jobs set photo_paths = case
  when cardinality(coalesce(photo_paths, '{}'::text[])) = 0 and photo_path is not null
    then array[photo_path]
  else coalesce(photo_paths, '{}'::text[])
end
where photo_paths is null or (cardinality(photo_paths) = 0 and photo_path is not null);
alter table public.jobs alter column photo_paths set default '{}'::text[];
alter table public.jobs alter column photo_paths set not null;
update public.jobs set photo_path = photo_paths[1]
where photo_path is distinct from photo_paths[1];

create or replace function private.valid_job_photo_paths(p_id uuid, p_paths text[])
returns boolean
language sql immutable set search_path = ''
as $$
  select p_paths is not null
    and (pg_catalog.cardinality(p_paths) = 0 or
      (pg_catalog.array_ndims(p_paths) = 1 and pg_catalog.array_lower(p_paths, 1) = 1))
    and not exists (
      select 1 from pg_catalog.unnest(p_paths) as photos(path)
      where path is null or path <> pg_catalog.btrim(path)
        or pg_catalog.split_part(path, '/', 1) <> p_id::text
        or path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|heic|heif)$'
    )
    and pg_catalog.cardinality(p_paths) = (
      select count(distinct path) from pg_catalog.unnest(p_paths) as photos(path)
    );
$$;

alter table public.jobs drop constraint if exists jobs_photo_paths_check;
alter table public.jobs add constraint jobs_photo_paths_check
  check (private.valid_job_photo_paths(id, photo_paths));
alter table public.jobs drop constraint if exists jobs_photo_primary_check;
alter table public.jobs add constraint jobs_photo_primary_check
  check (photo_path is not distinct from photo_paths[1]);
alter table public.jobs drop constraint if exists jobs_installed_photo;
alter table public.jobs add constraint jobs_installed_photo
  check (status <> 'installed' or (cardinality(photo_paths) > 0 and installed_at is not null));

create index if not exists jobs_status_updated_idx on public.jobs(status, updated_at desc);
create index if not exists jobs_created_by_idx on public.jobs(created_by);
create index if not exists jobs_updated_by_idx on public.jobs(updated_by);
create index if not exists jobs_measured_by_idx on public.jobs(measured_by);
create index if not exists jobs_cutting_by_idx on public.jobs(cutting_by);
create index if not exists jobs_cut_by_idx on public.jobs(cut_by);
create index if not exists jobs_installed_by_idx on public.jobs(installed_by);
create index if not exists jobs_photo_path_idx on public.jobs(photo_path) where photo_path is not null;

create table if not exists public.job_locks (
  job_id uuid primary key references public.jobs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  token uuid not null,
  expires_at timestamptz not null
);
create index if not exists job_locks_user_id_idx on public.job_locks(user_id);

create or replace function private.prepare_job()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  measurement_changed boolean;
  attached_path text;
begin
  new.store_name := btrim(new.store_name);
  new.responsible_name := btrim(new.responsible_name);
  new.photo_path := nullif(btrim(new.photo_path), '');
  new.updated_at := pg_catalog.now();
  new.updated_by := actor;

  if tg_op = 'INSERT' then
    if new.status <> 'measured' then
      raise exception 'El trabajo debe empezar con la medición.' using errcode = '23514';
    end if;
    new.created_at := pg_catalog.now();
    new.created_by := actor;
    new.measured_at := pg_catalog.now();
    new.measured_by := actor;
    new.cutting_at := null;
    new.cutting_by := null;
    new.cut_at := null;
    new.cut_by := null;
    new.installed_at := null;
    new.installed_by := null;
    new.version := 1;
  else
    -- El cliente no puede falsear autor, identificador ni fechas de auditoría.
    new.id := old.id;
    -- Un cliente antiguo solo conoce photo_path: reemplaza la primera y
    -- conserva las demás. Un cambio del array completo tiene prioridad.
    if new.photo_paths is not distinct from old.photo_paths
      and new.photo_path is distinct from old.photo_path then
      new.photo_paths := case when new.photo_path is null
        then coalesce(old.photo_paths[2:], '{}'::text[])
        else array[new.photo_path] || coalesce(old.photo_paths[2:], '{}'::text[])
      end;
    end if;
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    new.measured_at := old.measured_at;
    new.measured_by := old.measured_by;
    new.cutting_at := old.cutting_at;
    new.cutting_by := old.cutting_by;
    new.cut_at := old.cut_at;
    new.cut_by := old.cut_by;
    new.installed_at := old.installed_at;
    new.installed_by := old.installed_by;
    new.version := old.version + 1;

    measurement_changed := (new.width_cm is distinct from old.width_cm
        or new.length_cm is distinct from old.length_cm
        or new.quantity is distinct from old.quantity
        or new.thickness_mm is distinct from old.thickness_mm
        or new.material is distinct from old.material);
    if measurement_changed and not (
      new.status = 'measured' or
      (old.status = 'measured' and new.status = 'cut')
    ) then
      raise exception 'Vuelve a medir el trabajo antes de cambiar medidas, espesor o material.'
        using errcode = '23514';
    end if;
    if measurement_changed then
      new.measured_at := pg_catalog.now();
      new.measured_by := actor;
    end if;

    if new.status is distinct from old.status then
      if old.status = 'installed' then
        raise exception 'Un trabajo colocado no puede volver a una fase anterior.' using errcode = '23514';
      end if;
      if not (
        new.status = 'measured' or
        (old.status = 'measured' and new.status = 'cut') or
        (old.status = 'cut' and new.status = 'installed')
      ) then
        raise exception 'Completa la fase anterior antes de avanzar el trabajo.' using errcode = '23514';
      end if;
      case new.status
        when 'measured' then
          new.measured_at := pg_catalog.now();
          new.measured_by := actor;
          new.cutting_at := null;
          new.cutting_by := null;
          new.cut_at := null;
          new.cut_by := null;
          new.installed_at := null;
          new.installed_by := null;
        when 'cut' then
          new.cut_at := pg_catalog.now();
          new.cut_by := actor;
          new.installed_at := null;
          new.installed_by := null;
        when 'installed' then
          new.installed_at := pg_catalog.now();
          new.installed_by := actor;
        else null; -- El CHECK de status rechaza valores desconocidos.
      end case;
    end if;
  end if;

  if tg_op = 'INSERT' and cardinality(new.photo_paths) = 0 and new.photo_path is not null then
    new.photo_paths := array[new.photo_path];
  end if;
  new.photo_path := new.photo_paths[1];
  if not private.valid_job_photo_paths(new.id, new.photo_paths) then
    raise exception 'Las fotos deben tener rutas válidas, únicas y pertenecer a este felpudo.'
      using errcode = '23514';
  end if;
  if new.status = 'installed' and cardinality(new.photo_paths) = 0 then
    raise exception 'Te falta hacer la foto del felpudo colocado.' using errcode = '23514';
  end if;

  -- Una ruta escrita a mano no basta: el objeto debe haberse subido a Storage.
  foreach attached_path in array new.photo_paths loop
    if not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'job-photos' and o.name = attached_path
      for key share
    ) then
      raise exception 'La foto todavía no está subida. Inténtalo de nuevo.' using errcode = '23514';
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists jobs_prepare on public.jobs;
create trigger jobs_prepare before insert or update on public.jobs
for each row execute function private.prepare_job();

alter table public.profiles enable row level security;
alter table public.jobs enable row level security;
alter table public.job_locks enable row level security;

-- Privilegios mínimos. El servicio de administración y el SQL Editor pueden
-- gestionar perfiles; el navegador solamente modifica su propio nombre.
revoke all on public.profiles from anon, authenticated;
revoke all on public.jobs from anon, authenticated;
revoke all on public.job_locks from anon, authenticated;
grant select on public.profiles to authenticated;
grant update(display_name) on public.profiles to authenticated;
grant select, insert on public.jobs to authenticated;
grant select(job_id, user_id, expires_at) on public.job_locks to authenticated;
grant all on public.profiles, public.jobs, public.job_locks to service_role;

drop policy if exists profiles_members_read on public.profiles;
create policy profiles_members_read on public.profiles for select to authenticated
using ((select private.is_active_member()));
drop policy if exists profiles_own_name on public.profiles;
create policy profiles_own_name on public.profiles for update to authenticated
using (id = (select auth.uid()) and (select private.is_active_member()))
with check (id = (select auth.uid()) and active);

drop policy if exists jobs_members_read on public.jobs;
create policy jobs_members_read on public.jobs for select to authenticated
using ((select private.is_active_member()));
drop policy if exists jobs_members_insert on public.jobs;
create policy jobs_members_insert on public.jobs for insert to authenticated
with check ((select private.is_active_member()) and created_by = (select auth.uid()));
drop policy if exists jobs_members_update on public.jobs;
-- UPDATE solo por la función update_job, con bloqueo y versión validados.
drop policy if exists jobs_admin_delete on public.jobs;
-- Tampoco se admite DELETE directo: no puede invalidar una edición en curso.

drop policy if exists job_locks_members_read on public.job_locks;
create policy job_locks_members_read on public.job_locks for select to authenticated
using ((select private.is_active_member()));

create or replace function public.acquire_job_lock(p_job_id uuid, p_token uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  acquired boolean;
begin
  if actor is null or not private.is_active_member() then
    raise exception 'Tu cuenta no tiene acceso al equipo.' using errcode = '42501';
  end if;
  if p_token is null then
    raise exception 'Falta el identificador de edición.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.jobs where id = p_job_id) then
    raise exception 'Este trabajo ya no existe.' using errcode = 'P0002';
  end if;

  insert into public.job_locks (job_id, user_id, token, expires_at)
  values (p_job_id, actor, p_token, pg_catalog.clock_timestamp() + interval '180 seconds')
  on conflict (job_id) do update set
    user_id = excluded.user_id,
    token = excluded.token,
    expires_at = excluded.expires_at
  where public.job_locks.expires_at <= pg_catalog.clock_timestamp()
    or (public.job_locks.user_id = actor and public.job_locks.token = p_token)
  returning true into acquired;
  return coalesce(acquired, false);
end;
$$;

create or replace function public.release_job_lock(p_job_id uuid, p_token uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.job_locks
  where job_id = p_job_id and user_id = (select auth.uid()) and token = p_token;
end;
$$;

create or replace function public.update_job(
  p_job_id uuid,
  p_token uuid,
  p_expected_version bigint,
  p_patch jsonb
)
returns public.jobs
language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  editing_lock public.job_locks%rowtype;
  current_job public.jobs%rowtype;
  saved_job public.jobs%rowtype;
  next_photo_paths text[];
  legacy_photo_path text;
begin
  if actor is null or not private.is_active_member() then
    raise exception 'Tu cuenta no tiene acceso al equipo.' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(p_patch) is distinct from 'object' then
    raise exception 'Los cambios no tienen un formato válido.' using errcode = '22023';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_object_keys(p_patch) as patch_key(key)
    where key not in (
      'store_name', 'address', 'width_cm', 'length_cm', 'quantity', 'thickness_mm',
      'material', 'responsible_name', 'notes', 'status', 'photo_path', 'photo_paths'
    )
  ) then
    raise exception 'Los cambios incluyen campos no permitidos.' using errcode = '22023';
  end if;
  if p_patch ? 'photo_paths' then
    if pg_catalog.jsonb_typeof(p_patch -> 'photo_paths') is distinct from 'array' then
      raise exception 'Las fotos deben enviarse como una lista.' using errcode = '22023';
    end if;
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(p_patch -> 'photo_paths') as photos(value)
      where pg_catalog.jsonb_typeof(value) is distinct from 'string'
    ) then
      raise exception 'La lista de fotos contiene una ruta no válida.' using errcode = '22023';
    end if;
  end if;

  select * into editing_lock from public.job_locks where job_id = p_job_id for update;
  if not found or editing_lock.user_id is distinct from actor
     or editing_lock.token is distinct from p_token
     or editing_lock.expires_at <= pg_catalog.clock_timestamp() then
    raise exception 'La edición ha caducado o la tiene otro trabajador. Vuelve a abrir el trabajo.'
      using errcode = '55P03';
  end if;

  select * into current_job from public.jobs where id = p_job_id for update;
  if not found then
    raise exception 'Este trabajo ya no existe.' using errcode = 'P0002';
  end if;
  if current_job.version is distinct from p_expected_version then
    raise exception 'El trabajo cambió. Actualiza los datos antes de guardar.'
      using errcode = '40001';
  end if;
  if editing_lock.expires_at <= pg_catalog.clock_timestamp() then
    raise exception 'La edición ha caducado. Vuelve a abrir el trabajo.' using errcode = '55P03';
  end if;

  next_photo_paths := current_job.photo_paths;
  if p_patch ? 'photo_paths' then
    select coalesce(array_agg(path order by position), '{}'::text[]) into next_photo_paths
    from pg_catalog.jsonb_array_elements_text(p_patch -> 'photo_paths') with ordinality as photos(path, position);
    if p_patch ? 'photo_path'
      and nullif(btrim(p_patch ->> 'photo_path'), '') is distinct from next_photo_paths[1] then
      raise exception 'La primera foto no coincide con la lista de fotos.' using errcode = '22023';
    end if;
  elsif p_patch ? 'photo_path' then
    legacy_photo_path := nullif(btrim(p_patch ->> 'photo_path'), '');
    next_photo_paths := case when legacy_photo_path is null
      then coalesce(current_job.photo_paths[2:], '{}'::text[])
      else array[legacy_photo_path] || coalesce(current_job.photo_paths[2:], '{}'::text[])
    end;
  end if;

  update public.jobs set
    store_name = case when p_patch ? 'store_name' then p_patch ->> 'store_name' else current_job.store_name end,
    address = case when p_patch ? 'address' then p_patch ->> 'address' else current_job.address end,
    width_cm = case when p_patch ? 'width_cm' then (p_patch ->> 'width_cm')::numeric else current_job.width_cm end,
    length_cm = case when p_patch ? 'length_cm' then (p_patch ->> 'length_cm')::numeric else current_job.length_cm end,
    quantity = case when p_patch ? 'quantity' then (p_patch ->> 'quantity')::integer else current_job.quantity end,
    thickness_mm = case when p_patch ? 'thickness_mm' then (p_patch ->> 'thickness_mm')::smallint else current_job.thickness_mm end,
    material = case when p_patch ? 'material' then p_patch ->> 'material' else current_job.material end,
    responsible_name = case when p_patch ? 'responsible_name' then p_patch ->> 'responsible_name' else current_job.responsible_name end,
    notes = case when p_patch ? 'notes' then p_patch ->> 'notes' else current_job.notes end,
    status = case when p_patch ? 'status' then p_patch ->> 'status' else current_job.status end,
    photo_path = next_photo_paths[1],
    photo_paths = next_photo_paths
  where id = p_job_id returning * into saved_job;
  return saved_job;
end;
$$;

-- Serializa el borrado de una foto con el guardado del trabajo. Sin este
-- bloqueo, una limpieza concurrente podría borrar una foto justo al adjuntarla.
create or replace function private.photo_is_unreferenced(p_name text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare attached_paths text[];
begin
  if not private.is_active_member() then return false; end if;
  select photo_paths into attached_paths from public.jobs
  where id::text = split_part(p_name, '/', 1) for update;
  return not (p_name = any(coalesce(attached_paths, '{}'::text[])));
end;
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'job-photos', 'job-photos', false, 10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists felpudos_photos_read on storage.objects;
create policy felpudos_photos_read on storage.objects for select to authenticated
using (
  bucket_id = 'job-photos' and (select private.is_active_member())
  and exists (select 1 from public.jobs j where j.id::text = (storage.foldername(name))[1])
);
drop policy if exists felpudos_photos_insert on storage.objects;
create policy felpudos_photos_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'job-photos' and (select private.is_active_member())
  and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|heic|heif)$'
  and exists (select 1 from public.jobs j where j.id::text = (storage.foldername(name))[1])
  and exists (
    select 1 from public.job_locks l
    where l.job_id::text = (storage.foldername(name))[1]
      and l.user_id = (select auth.uid()) and l.expires_at > pg_catalog.clock_timestamp()
  )
);
drop policy if exists felpudos_photos_delete_unused on storage.objects;
create policy felpudos_photos_delete_unused on storage.objects for delete to authenticated
using (
  bucket_id = 'job-photos' and (select private.is_active_member())
  and (owner_id = (select auth.uid())::text or (select private.is_admin()))
  and private.photo_is_unreferenced(name)
);
-- Sin política UPDATE: upsert:false evita reemplazar fotografías ya guardadas.

revoke all on function private.enforce_member_limit() from public, anon, authenticated;
revoke all on function private.handle_new_user() from public, anon, authenticated;
revoke all on function private.prepare_job() from public, anon, authenticated;
revoke all on function private.valid_job_photo_paths(uuid, text[]) from public, anon;
grant execute on function private.valid_job_photo_paths(uuid, text[]) to authenticated, service_role;
revoke all on function private.is_active_member() from public, anon;
revoke all on function private.is_admin() from public, anon;
revoke all on function private.photo_is_unreferenced(text) from public, anon;
grant execute on function private.is_active_member() to authenticated;
grant execute on function private.is_admin() to authenticated;
grant execute on function private.photo_is_unreferenced(text) to authenticated;
revoke all on function public.acquire_job_lock(uuid, uuid) from public, anon;
revoke all on function public.release_job_lock(uuid, uuid) from public, anon;
revoke all on function public.update_job(uuid, uuid, bigint, jsonb) from public, anon;
grant execute on function public.acquire_job_lock(uuid, uuid) to authenticated;
grant execute on function public.release_job_lock(uuid, uuid) to authenticated;
grant execute on function public.update_job(uuid, uuid, bigint, jsonb) to authenticated;

-- Realtime mantiene sincronizados los estados en los móviles. El acceso a
-- postgres_changes respeta las políticas SELECT de jobs.
do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_catalog.pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'jobs'
     ) then
    alter publication supabase_realtime add table public.jobs;
  end if;
end;
$$;

-- Tipos de trabajo y revisiones; mismo contrato que la migración 20261009.
lock table public.jobs in access exclusive mode;
alter table public.jobs add column if not exists job_kind text not null default 'mat';
alter table public.jobs add column if not exists review_status text not null default 'pending';
alter table public.jobs add column if not exists rework_kind text;
alter table public.jobs add column if not exists revision_no integer not null default 0;
alter table public.jobs add column if not exists review_notes text not null default '';
alter table public.jobs add column if not exists reviewed_at timestamptz;
alter table public.jobs add column if not exists reviewed_by uuid references auth.users(id) on delete set null;
alter table public.jobs alter column width_cm drop not null;
alter table public.jobs alter column length_cm drop not null;
alter table public.jobs alter column measured_at drop not null;
alter table public.jobs drop constraint if exists jobs_quantity_check;
alter table public.jobs add constraint jobs_quantity_check check (
  (job_kind = 'mat' and quantity = 1) or (job_kind = 'dehumidifier' and quantity > 0)
);
alter table public.jobs drop constraint if exists jobs_status_check;
alter table public.jobs add constraint jobs_status_check check (status in (
  'pending_measurement', 'measured', 'cut', 'installed', 'pending_installation', 'pending_adjustment'
));
alter table public.jobs drop constraint if exists jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check check (job_kind in ('mat', 'dehumidifier'));
alter table public.jobs drop constraint if exists jobs_review_status_check;
alter table public.jobs add constraint jobs_review_status_check check (review_status in ('pending', 'approved', 'needs_adjustment'));
alter table public.jobs drop constraint if exists jobs_rework_kind_check;
alter table public.jobs add constraint jobs_rework_kind_check check (rework_kind is null or rework_kind in ('trim', 'add', 'replace'));
alter table public.jobs drop constraint if exists jobs_revision_no_check;
alter table public.jobs add constraint jobs_revision_no_check check (revision_no >= 0);
alter table public.jobs drop constraint if exists jobs_review_notes_check;
alter table public.jobs add constraint jobs_review_notes_check check (char_length(review_notes) <= 3000);
alter table public.jobs drop constraint if exists jobs_dimensions_check;
alter table public.jobs add constraint jobs_dimensions_check check (
  (job_kind = 'dehumidifier' and width_cm is null and length_cm is null) or
  (job_kind = 'mat' and (
    (status = 'pending_measurement' and width_cm is null and length_cm is null) or
    (width_cm is not null and length_cm is not null and width_cm > 0 and length_cm > 0)
  ))
);

create table if not exists public.job_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  revision_no integer not null check (revision_no >= 0),
  event_type text not null check (event_type in ('review_approved', 'rework_started')),
  notes text not null default '' check (char_length(notes) <= 3000),
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object')
);
create index if not exists job_events_job_created_idx on public.job_events(job_id, created_at desc);
create index if not exists jobs_kind_status_updated_idx on public.jobs(job_kind, status, updated_at desc);
alter table public.job_events enable row level security;
revoke all on public.job_events from public, anon, authenticated;
grant select on public.job_events to authenticated;
grant all on public.job_events to service_role;
drop policy if exists job_events_members_read on public.job_events;
create policy job_events_members_read on public.job_events for select to authenticated
using ((select private.is_active_member()));

-- Solo review_job puede abrir este permiso interno, limitado a esta transacción,
-- trabajo, autor y versión. Un set_config del cliente no puede falsificarlo.
create table if not exists private.job_review_context (
  job_id uuid primary key references public.jobs(id) on delete cascade,
  transaction_id bigint not null,
  actor_id uuid not null,
  expected_version bigint not null,
  action text not null check (action in ('approve', 'trim', 'add', 'replace'))
);
revoke all on private.job_review_context from public, anon, authenticated;
alter table private.job_review_context enable row level security;

create or replace function private.prepare_job()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  measurement_changed boolean;
  attached_path text;
  review_action text;
begin
  new.store_name := btrim(new.store_name);
  new.responsible_name := btrim(new.responsible_name);
  new.photo_path := nullif(btrim(new.photo_path), '');
  new.updated_at := pg_catalog.now();
  new.updated_by := actor;

  if tg_op = 'INSERT' then
    if not (
      (new.job_kind = 'mat' and new.status in ('pending_measurement', 'measured')) or
      (new.job_kind = 'dehumidifier' and new.status = 'pending_installation')
    ) then
      raise exception 'El trabajo debe empezar en su primera fase.' using errcode = '23514';
    end if;
    new.created_at := pg_catalog.now();
    new.created_by := actor;
    new.measured_at := case when new.status = 'measured' then pg_catalog.now() else null end;
    new.measured_by := case when new.status = 'measured' then actor else null end;
    new.cutting_at := null;
    new.cutting_by := null;
    new.cut_at := null;
    new.cut_by := null;
    new.installed_at := null;
    new.installed_by := null;
    new.version := 1;
    new.review_status := 'pending';
    new.rework_kind := null;
    new.revision_no := 0;
    new.review_notes := '';
    new.reviewed_at := null;
    new.reviewed_by := null;
  else
    new.id := old.id;
    new.job_kind := old.job_kind;
    delete from private.job_review_context
    where job_id = old.id and transaction_id = pg_catalog.txid_current()
      and actor_id = actor and expected_version = old.version
    returning action into review_action;
    if new.photo_paths is not distinct from old.photo_paths
      and new.photo_path is distinct from old.photo_path then
      new.photo_paths := case when new.photo_path is null
        then coalesce(old.photo_paths[2:], '{}'::text[])
        else array[new.photo_path] || coalesce(old.photo_paths[2:], '{}'::text[])
      end;
    end if;
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    new.measured_at := old.measured_at;
    new.measured_by := old.measured_by;
    new.cutting_at := old.cutting_at;
    new.cutting_by := old.cutting_by;
    new.cut_at := old.cut_at;
    new.cut_by := old.cut_by;
    new.installed_at := old.installed_at;
    new.installed_by := old.installed_by;
    new.version := old.version + 1;

    if review_action is null then
      new.review_status := old.review_status;
      new.rework_kind := old.rework_kind;
      new.revision_no := old.revision_no;
      new.review_notes := old.review_notes;
      new.reviewed_at := old.reviewed_at;
      new.reviewed_by := old.reviewed_by;
      measurement_changed := (new.width_cm is distinct from old.width_cm
          or new.length_cm is distinct from old.length_cm
          or new.quantity is distinct from old.quantity
          or new.thickness_mm is distinct from old.thickness_mm
          or new.material is distinct from old.material);
      if new.job_kind = 'dehumidifier' then
        if measurement_changed and old.status = 'installed' then
          raise exception 'La cantidad de un trabajo colocado no se puede cambiar.' using errcode = '23514';
        end if;
      else
        if measurement_changed and not (
          new.status in ('pending_measurement', 'measured') or
          (old.status = 'measured' and new.status = 'cut')
        ) then
          raise exception 'Vuelve a medir el trabajo antes de cambiar medidas, espesor o material.' using errcode = '23514';
        end if;
        if measurement_changed and new.status <> 'pending_measurement' then
          new.measured_at := pg_catalog.now();
          new.measured_by := actor;
        end if;
      end if;

      if new.status is distinct from old.status then
        if old.status = 'installed' then
          raise exception 'Para reabrir un trabajo colocado utiliza su revisión.' using errcode = '23514';
        end if;
        if not (
          (new.job_kind = 'dehumidifier' and old.status = 'pending_installation' and new.status = 'installed') or
          (new.job_kind = 'mat' and (
            (old.status = 'pending_measurement' and new.status = 'measured') or
            (old.status = 'measured' and new.status = 'cut') or
            (old.status = 'cut' and new.status in ('measured', 'installed')) or
            (old.status = 'pending_adjustment' and new.status = 'installed')
          ))
        ) then
          raise exception 'Completa la fase anterior antes de avanzar el trabajo.' using errcode = '23514';
        end if;
        case new.status
          when 'measured' then
            new.measured_at := pg_catalog.now();
            new.measured_by := actor;
            new.cutting_at := null;
            new.cutting_by := null;
            new.cut_at := null;
            new.cut_by := null;
            new.installed_at := null;
            new.installed_by := null;
          when 'cut' then
            new.cut_at := pg_catalog.now();
            new.cut_by := actor;
            new.installed_at := null;
            new.installed_by := null;
          when 'installed' then
            new.installed_at := pg_catalog.now();
            new.installed_by := actor;
            new.review_status := 'pending';
            new.reviewed_at := null;
            new.reviewed_by := null;
          else null;
        end case;
      end if;
    elsif review_action <> 'approve' then
      new.installed_at := null;
      new.installed_by := null;
      new.cutting_at := null;
      new.cutting_by := null;
      new.cut_at := null;
      new.cut_by := null;
      if new.status = 'pending_measurement' then
        new.measured_at := null;
        new.measured_by := null;
      end if;
    end if;
  end if;

  if new.job_kind = 'dehumidifier' then
    if new.status not in ('pending_installation', 'installed') then
      raise exception 'El deshumidificador solo tiene pendiente de colocar y colocado.' using errcode = '23514';
    end if;
    if new.width_cm is not null or new.length_cm is not null or new.thickness_mm is not null or new.material <> '' then
      raise exception 'Los deshumidificadores no tienen medidas, espesor ni material de felpudo.' using errcode = '23514';
    end if;
    new.measured_at := null;
    new.measured_by := null;
  elsif new.status = 'pending_installation' then
    raise exception 'La fase no corresponde a un felpudo.' using errcode = '23514';
  end if;

  if tg_op = 'INSERT' and cardinality(new.photo_paths) = 0 and new.photo_path is not null then
    new.photo_paths := array[new.photo_path];
  end if;
  new.photo_path := new.photo_paths[1];
  if not private.valid_job_photo_paths(new.id, new.photo_paths) then
    raise exception 'Las fotos deben tener rutas válidas, únicas y pertenecer a este trabajo.' using errcode = '23514';
  end if;
  if new.status = 'installed' and cardinality(new.photo_paths) = 0 then
    raise exception 'Te falta hacer la foto del trabajo colocado.' using errcode = '23514';
  end if;
  foreach attached_path in array new.photo_paths loop
    if exists (
      select 1 from public.job_events e where e.job_id = new.id
        and e.event_type = 'rework_started'
        and (e.snapshot -> 'photo_paths') ? attached_path
    ) then
      raise exception 'La corrección necesita fotos nuevas; las anteriores se conservan en el historial.' using errcode = '23514';
    end if;
    if not exists (
      select 1 from storage.objects o where o.bucket_id = 'job-photos' and o.name = attached_path for key share
    ) then
      raise exception 'La foto todavía no está subida. Inténtalo de nuevo.' using errcode = '23514';
    end if;
  end loop;
  return new;
end;
$$;

create or replace function public.review_job(
  p_job_id uuid,
  p_token uuid,
  p_expected_version bigint,
  p_action text,
  p_notes text default ''
)
returns public.jobs
language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  editing_lock public.job_locks%rowtype;
  current_job public.jobs%rowtype;
  saved_job public.jobs%rowtype;
  saved_review_notes text := btrim(coalesce(p_notes, ''));
begin
  if actor is null or not private.is_active_member() then
    raise exception 'Tu cuenta no tiene acceso al equipo.' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('approve', 'trim', 'add', 'replace') then
    raise exception 'La revisión no tiene una acción válida.' using errcode = '22023';
  end if;
  if char_length(saved_review_notes) > 3000 or (p_action <> 'approve' and saved_review_notes = '') then
    raise exception 'Indica qué hay que corregir, en un máximo de 3000 caracteres.' using errcode = '22023';
  end if;
  select * into editing_lock from public.job_locks where job_id = p_job_id for update;
  if not found or editing_lock.user_id is distinct from actor
    or editing_lock.token is distinct from p_token
    or editing_lock.expires_at <= pg_catalog.clock_timestamp() then
    raise exception 'La edición ha caducado o la tiene otro trabajador. Vuelve a abrir el trabajo.' using errcode = '55P03';
  end if;
  select * into current_job from public.jobs where id = p_job_id for update;
  if not found then
    raise exception 'Este trabajo ya no existe.' using errcode = 'P0002';
  end if;
  if current_job.version is distinct from p_expected_version then
    raise exception 'El trabajo cambió. Actualiza los datos antes de guardar.' using errcode = '40001';
  end if;
  if editing_lock.expires_at <= pg_catalog.clock_timestamp() then
    raise exception 'La edición ha caducado. Vuelve a abrir el trabajo.' using errcode = '55P03';
  end if;
  if current_job.job_kind <> 'mat' or current_job.status <> 'installed' then
    raise exception 'Solo se puede revisar un felpudo colocado.' using errcode = '23514';
  end if;
  insert into public.job_events(job_id, revision_no, event_type, notes, actor_id, snapshot)
  values (current_job.id,
    current_job.revision_no + case when p_action = 'approve' then 0 else 1 end,
    case when p_action = 'approve' then 'review_approved' else 'rework_started' end,
    saved_review_notes, actor, to_jsonb(current_job));
  insert into private.job_review_context(job_id, transaction_id, actor_id, expected_version, action)
  values (current_job.id, pg_catalog.txid_current(), actor, current_job.version, p_action);
  update public.jobs set
    review_status = case when p_action = 'approve' then 'approved' else 'needs_adjustment' end,
    rework_kind = case when p_action = 'approve' then current_job.rework_kind else p_action end,
    revision_no = current_job.revision_no + case when p_action = 'approve' then 0 else 1 end,
    review_notes = saved_review_notes,
    reviewed_at = pg_catalog.now(),
    reviewed_by = actor,
    status = case p_action when 'approve' then current_job.status when 'trim' then 'pending_adjustment' else 'pending_measurement' end,
    width_cm = case when p_action in ('add', 'replace') then null else current_job.width_cm end,
    length_cm = case when p_action in ('add', 'replace') then null else current_job.length_cm end,
    photo_paths = case when p_action = 'approve' then current_job.photo_paths else '{}'::text[] end,
    photo_path = case when p_action = 'approve' then current_job.photo_path else null end
  where id = current_job.id returning * into saved_job;
  return saved_job;
end;
$$;

-- Una foto del historial también queda adjunta: no se puede borrar al limpiar
-- subidas fallidas. El bloqueo de jobs serializa revisión, guardado y borrado.
create or replace function private.photo_is_unreferenced(p_name text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  attached_paths text[];
  target_id uuid;
begin
  if not private.is_active_member() then return false; end if;
  select id, photo_paths into target_id, attached_paths from public.jobs
  where id::text = split_part(p_name, '/', 1) for update;
  if p_name = any(coalesce(attached_paths, '{}'::text[])) then return false; end if;
  return not exists (
    select 1 from public.job_events e where e.job_id = target_id
      and ((e.snapshot -> 'photo_paths') ? p_name or e.snapshot ->> 'photo_path' = p_name)
  );
end;
$$;

revoke all on function private.prepare_job() from public, anon, authenticated;
revoke all on function private.photo_is_unreferenced(text) from public, anon;
grant execute on function private.photo_is_unreferenced(text) to authenticated;
revoke all on function public.review_job(uuid, uuid, bigint, text, text) from public, anon;
grant execute on function public.review_job(uuid, uuid, bigint, text, text) to authenticated;

do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
    and not exists (select 1 from pg_catalog.pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'job_events') then
    alter publication supabase_realtime add table public.job_events;
  end if;
end;
$$;

commit;
