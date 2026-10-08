-- Control de trabajos: Medido → Cortado → Colocado; una tarea por felpudo.
-- Ejecutar completo en SQL Editor. Transacción reejecutable: conserva usuarios,
-- medidas, notas, responsables, fotos, bloqueos, permisos y versiones.
begin;

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
  if exists (select 1 from public.jobs where quantity > 1 and status = 'installed') then
    raise exception 'Hay trabajos colocados con varias unidades. Sepáralos con su foto individual antes de actualizar.'
      using errcode = '23514';
  end if;

  for source_job in select * from public.jobs where quantity > 1 order by id loop
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
alter table public.jobs add constraint jobs_quantity_check check (quantity = 1);
alter table public.jobs drop constraint if exists jobs_status_check;
alter table public.jobs add constraint jobs_status_check check (status in ('measured', 'cut', 'installed'));

-- La función y el trigger se incluyen debajo para aplicar la misma validación
-- que en schema.sql, manteniendo update_job y sus bloqueos/versiones existentes.

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

  if new.status = 'installed' and new.photo_path is null then
    raise exception 'Te falta hacer la foto del felpudo colocado.' using errcode = '23514';
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

commit;
