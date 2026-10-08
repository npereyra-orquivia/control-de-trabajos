-- Control de trabajos: varias fotos por felpudo; mínimo una al colocar.
-- Ejecutar completo después de 20261008_three_stages_one_mat.sql.
-- Transacción reejecutable: conserva fotos, autores, fechas, versiones y bloqueos.
begin;
lock table public.jobs in access exclusive mode;
drop trigger if exists jobs_prepare on public.jobs;
alter table public.jobs add column if not exists photo_paths text[] not null default '{}'::text[];

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

create trigger jobs_prepare before insert or update on public.jobs
for each row execute function private.prepare_job();

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

-- La política existente de borrado usa photo_is_unreferenced, que ahora
-- comprueba todo el array bajo el mismo bloqueo de fila que update_job.
revoke all on function private.prepare_job() from public, anon, authenticated;
revoke all on function private.valid_job_photo_paths(uuid, text[]) from public, anon;
grant execute on function private.valid_job_photo_paths(uuid, text[]) to authenticated, service_role;
revoke all on function private.photo_is_unreferenced(text) from public, anon;
grant execute on function private.photo_is_unreferenced(text) to authenticated;
revoke all on function public.update_job(uuid, uuid, bigint, jsonb) from public, anon;
grant execute on function public.update_job(uuid, uuid, bigint, jsonb) to authenticated;

commit;
