-- Felpudos: ejecutar completo en Supabase > SQL Editor, en un proyecto dedicado.
-- No contiene contraseñas ni claves. Desactivar altas públicas en Authentication.
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
  width_cm numeric(8, 2) not null check (width_cm > 0 and width_cm <= 100000),
  length_cm numeric(8, 2) not null check (length_cm > 0 and length_cm <= 100000),
  quantity integer not null default 1 check (quantity between 1 and 100),
  material text not null default '' check (char_length(material) <= 100),
  notes text not null default '' check (char_length(notes) <= 3000),
  status text not null default 'measured'
    check (status in ('measured', 'cutting', 'cut', 'installed')),
  photo_path text,
  measured_at timestamptz not null default now(),
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
    status <> 'installed' or (photo_path is not null and installed_at is not null)
  )
);

-- Actualiza también instalaciones previas. Las etapas históricas sin autor
-- se conservan como null: no se atribuyen a un trabajador que no conocemos.
alter table public.jobs add column if not exists measured_by uuid references auth.users(id) on delete set null;
alter table public.jobs add column if not exists cutting_by uuid references auth.users(id) on delete set null;
alter table public.jobs add column if not exists cut_by uuid references auth.users(id) on delete set null;
alter table public.jobs add column if not exists installed_by uuid references auth.users(id) on delete set null;

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
begin
  new.store_name := btrim(new.store_name);
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
        or new.material is distinct from old.material);
    if measurement_changed and not (
      new.status = 'measured' or
      (old.status = 'measured' and new.status = 'cutting')
    ) then
      raise exception 'Vuelve a medir el trabajo antes de cambiar medidas, material o cantidad.'
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
        (old.status = 'measured' and new.status = 'cutting') or
        (old.status = 'cutting' and new.status = 'cut') or
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
        when 'cutting' then
          new.cutting_at := pg_catalog.now();
          new.cutting_by := actor;
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

  -- Una ruta escrita a mano no basta: el objeto debe haberse subido a Storage.
  if new.photo_path is not null then
    if not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'job-photos' and o.name = new.photo_path
      for key share
    ) then
      raise exception 'La foto todavía no está subida. Inténtalo de nuevo.' using errcode = '23514';
    end if;
  end if;
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
      'store_name', 'address', 'width_cm', 'length_cm', 'quantity',
      'material', 'notes', 'status', 'photo_path'
    )
  ) then
    raise exception 'Los cambios incluyen campos no permitidos.' using errcode = '22023';
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

  update public.jobs set
    store_name = case when p_patch ? 'store_name' then p_patch ->> 'store_name' else current_job.store_name end,
    address = case when p_patch ? 'address' then p_patch ->> 'address' else current_job.address end,
    width_cm = case when p_patch ? 'width_cm' then (p_patch ->> 'width_cm')::numeric else current_job.width_cm end,
    length_cm = case when p_patch ? 'length_cm' then (p_patch ->> 'length_cm')::numeric else current_job.length_cm end,
    quantity = case when p_patch ? 'quantity' then (p_patch ->> 'quantity')::integer else current_job.quantity end,
    material = case when p_patch ? 'material' then p_patch ->> 'material' else current_job.material end,
    notes = case when p_patch ? 'notes' then p_patch ->> 'notes' else current_job.notes end,
    status = case when p_patch ? 'status' then p_patch ->> 'status' else current_job.status end,
    photo_path = case when p_patch ? 'photo_path' then p_patch ->> 'photo_path' else current_job.photo_path end
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
declare attached_path text;
begin
  if not private.is_active_member() then return false; end if;
  select photo_path into attached_path from public.jobs
  where id::text = split_part(p_name, '/', 1) for update;
  return attached_path is distinct from p_name;
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

commit;
