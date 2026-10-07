-- Control de trabajos: responsable del trabajo; vacío significa «Sin asignar».
-- Ejecutar completo en SQL Editor. Reejecutable; conserva trabajos, usuarios,
-- materiales, medidas, estados, fotos, bloqueos, políticas y concesiones.
begin;

alter table public.jobs add column if not exists responsible_name text not null default '';
alter table public.jobs alter column responsible_name set default '';
alter table public.jobs alter column responsible_name set not null;
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.jobs'::regclass and conname = 'jobs_responsible_name_check'
  ) then
    alter table public.jobs add constraint jobs_responsible_name_check
      check (char_length(btrim(responsible_name)) <= 100);
  end if;
end;
$$;

create or replace function private.prepare_job()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  measurement_changed boolean;
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
      (old.status = 'measured' and new.status = 'cutting')
    ) then
      raise exception 'Vuelve a medir el trabajo antes de cambiar medidas, espesor, material o cantidad.'
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
      'store_name', 'address', 'width_cm', 'length_cm', 'quantity', 'thickness_mm',
      'material', 'responsible_name', 'notes', 'status', 'photo_path'
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
    thickness_mm = case when p_patch ? 'thickness_mm' then (p_patch ->> 'thickness_mm')::smallint else current_job.thickness_mm end,
    material = case when p_patch ? 'material' then p_patch ->> 'material' else current_job.material end,
    responsible_name = case when p_patch ? 'responsible_name' then p_patch ->> 'responsible_name' else current_job.responsible_name end,
    notes = case when p_patch ? 'notes' then p_patch ->> 'notes' else current_job.notes end,
    status = case when p_patch ? 'status' then p_patch ->> 'status' else current_job.status end,
    photo_path = case when p_patch ? 'photo_path' then p_patch ->> 'photo_path' else current_job.photo_path end
  where id = p_job_id returning * into saved_job;
  return saved_job;
end;
$$;

commit;
