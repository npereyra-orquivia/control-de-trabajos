-- Ejecutar después de 20261008_multiple_photos.sql. Transacción reejecutable.
-- No clasifica trabajos por nombre ni cambia datos existentes.
begin;

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
