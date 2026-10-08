import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { Session } from "@supabase/supabase-js";
import {
  ArrowDown,
  ArrowRight,
  Camera,
  AirVent,
  Check,
  CheckCheck,
  ChevronDown,
  ClipboardList,
  Clock3,
  Download,
  Info,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Plus,
  RefreshCw,
  Ruler,
  Scissors,
  Search,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import {
  MATERIALS,
  STATUSES,
  type Job,
  type JobInput,
  type JobLock,
  type JobPatch,
  type JobEvent,
  type JobKind,
  type ReworkKind,
  type Profile,
  type Status,
} from "./types";
import { supabase } from "./lib/supabase";
import { resolveLoginEmail } from "./lib/login.mjs";
import { getMaterialOptions, getResponsibleOptions, matchesJob, sortJobsForWorkspace } from "./lib/filters.mjs";
import { appendPhotoPaths, jobPhotoPaths, photoPatchIsSaved } from "./lib/photos.mjs";
import { combineJobNotes, editableNotesLimit, prepareJobNotes } from "./lib/notes.mjs";
import { getJobStages, jobKind, statusLabel, reviewPatchIsSaved } from "./lib/workflow.mjs";
import {
  acquireDemo,
  createDemo,
  demoJobs,
  demoLocks,
  demoProfile,
  demoProfiles,
  releaseDemo,
  reviewDemo,
  demoEvents,
  updateDemo,
} from "./lib/demo";
import {
  nextStatus,
  parseMeasure,
  validateInput,
  validatePhoto,
} from "./lib/validation.mjs";

type EditorState = {
  job: Job | null;
  token: string | null;
  readonly: boolean;
  draftId?: string;
  kind?: JobKind;
};
const icons = {
  pending_measurement: Ruler,
  pending_adjustment: Scissors,
  pending_installation: AirVent,
  measured: Ruler,
  cut: Scissors,
  installed: CheckCheck,
};
const reviewLabels = { pending: "Pendiente revisar", approved: "Revisado", needs_adjustment: "Corrección pendiente" };
const reworkLabels = { trim: "Recortar", add: "Añadir una parte", replace: "Reponer entero" };
const format = (number: number) =>
  new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 }).format(number);
const dateTime = (value: string) =>
  new Intl.DateTimeFormat("es-ES", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
function errorMessage(error: unknown): string {
  const code =
    typeof error === "object" && error && "code" in error
      ? String(error.code)
      : "";
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error && "message" in error
        ? String(error.message)
        : "No se ha podido completar la operación.";
  if (/Invalid login credentials/i.test(raw))
    return "El usuario, el correo o la contraseña no son correctos.";
  if (/Failed to fetch|NetworkError|fetch failed/i.test(raw))
    return "No hay conexión. Comprueba la red y vuelve a intentarlo.";
  if (code === "email_not_confirmed" || /Email not confirmed/i.test(raw))
    return "Revisa tu correo y confirma tu cuenta antes de entrar.";
  if (
    ["email_exists", "user_already_exists"].includes(code) ||
    /User already registered|already exists/i.test(raw)
  )
    return "Este correo ya tiene una cuenta. Pulsa Iniciar sesión.";
  if (
    code === "email_address_not_authorized" ||
    /Email address not authorized|email_address_not_authorized/i.test(raw)
  )
    return "El envío de correos de confirmación aún no está configurado para este correo. Contacta con quien administra la app.";
  if (/Database error saving new user/i.test(raw))
    return "No se ha podido crear la cuenta. El equipo admite hasta cinco usuarios; consulta con quien administra la app.";
  if (
    code === "signup_disabled" ||
    /Signups not allowed|signup.*disabled/i.test(raw)
  )
    return "El registro todavía no está habilitado. Vuelve a intentarlo en unos minutos.";
  if (
    ["over_request_rate_limit", "over_email_send_rate_limit"].includes(code) ||
    /rate limit|too many requests/i.test(raw)
  )
    return "Se han realizado demasiados intentos. Espera unos minutos y vuelve a intentarlo.";
  if (/Password should|weak password/i.test(raw))
    return "Elige una contraseña de al menos ocho caracteres.";
  if (/Error sending confirmation email/i.test(raw))
    return "No se ha podido enviar el correo de confirmación. Contacta con quien administra la app para revisar el envío de correos.";
  return raw;
}
function AppLogo({ className = "" }: { className?: string }) {
  return (
    <img
      className={`app-logo ${className}`.trim()}
      src={`${import.meta.env.BASE_URL}logo.svg`}
      width={241}
      height={275}
      alt=""
      aria-hidden="true"
    />
  );
}
function Brand() {
  return (
    <div className="brand">
      <AppLogo className="brand-icon" />
      <span>
        control<span className="brand-light"> de trabajos</span>
        <small>FELPUDOS · DESHUMIDIFICADORES</small>
      </span>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(!supabase);
  const [demo, setDemo] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [locks, setLocks] = useState<JobLock[]>([]);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [exporting, setExporting] = useState(false);
  const [kind, setKind] = useState<JobKind>("mat");
  const [reviewFilter, setReviewFilter] = useState("all");
  const [filter, setFilter] = useState<Status | "all">("all");
  const [materialFilter, setMaterialFilter] = useState("all");
  const [responsibleFilter, setResponsibleFilter] = useState("all");
  const [thicknessFilter, setThicknessFilter] = useState<"all" | "17" | "20" | "unknown">("all");
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"jobs" | "team" | "help">("jobs");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const sectionFilters = useRef<Partial<Record<JobKind, {
    status: Status | "all"; material: string; responsible: string;
    thickness: "all" | "17" | "20" | "unknown"; search: string; review: string;
  }>>>({});
  const refreshInFlight = useRef(false);
  const refreshGeneration = useRef(0);
  const photoUploads = useRef(new Map<File, string>());
  const uncertainPhotoUploads = useRef(new Set<File>());
  const identity = demo ? demoProfile.id : session?.user.id;
  const profile = profiles.find((item) => item.id === identity);

  useEffect(() => {
    if (!supabase) return;
    let live = true;
    supabase.auth.getSession().then(({ data, error: authError }) => {
      if (live) {
        setSession(data.session);
        setAuthReady(true);
        if (authError) setError(errorMessage(authError));
      }
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (live) {
        setSession(nextSession);
        setAuthReady(true);
      }
    });
    return () => {
      live = false;
      data.subscription.unsubscribe();
    };
  }, []);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current || !identity) return;
    const generation = refreshGeneration.current;
    refreshInFlight.current = true;
    setRefreshing(true);
    try {
      if (demo) {
        setJobs(demoJobs());
        setProfiles(demoProfiles);
        setLocks(demoLocks());
      } else if (supabase) {
        const fetched: Job[] = [];
        let offset = 0;
        for (;;) {
          const { data, error: fetchError } = await supabase
            .from("jobs")
            .select("*")
            .order("created_at", { ascending: false })
            .order("id")
            .range(offset, offset + 999);
          if (fetchError) throw fetchError;
          fetched.push(...(data as Job[]));
          if (data.length < 1000) break;
          offset += 1000;
        }
        const [people, editing] = await Promise.all([
          supabase
            .from("profiles")
            .select("id,display_name,role,active")
            .order("display_name"),
          supabase
            .from("job_locks")
            .select("job_id,user_id,expires_at")
            .gt("expires_at", new Date().toISOString()),
        ]);
        if (people.error) throw people.error;
        if (editing.error) throw editing.error;
        if (!people.data.some((item) => item.id === identity && item.active))
          throw new Error(
            "Tu usuario no tiene acceso activo. Contacta con quien administra la app.",
          );
        if (generation !== refreshGeneration.current) return;
        setJobs(fetched);
        setProfiles(people.data as Profile[]);
        setLocks(editing.data as JobLock[]);
      }
      if (generation === refreshGeneration.current) {
        setLastSync(new Date());
        setError("");
      }
    } catch (fetchError) {
      if (generation === refreshGeneration.current)
        setError(errorMessage(fetchError));
    } finally {
      if (generation === refreshGeneration.current) {
        refreshInFlight.current = false;
        setRefreshing(false);
        setInitialLoading(false);
      }
    }
  }, [demo, identity]);

  useEffect(() => {
    refreshGeneration.current += 1;
    refreshInFlight.current = false;
    if (!identity) return;
    setInitialLoading(true);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 120000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const onOnline = () => {
      setOnline(true);
      void refresh();
    };
    const onOffline = () => setOnline(false);
    const onStorage = () => {
      if (demo) void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("storage", onStorage);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("storage", onStorage);
    };
  }, [identity, refresh, demo]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  async function acquire(id: string, token: string) {
    if (demo) return acquireDemo(id, token);
    const result = await supabase!.rpc("acquire_job_lock", {
      p_job_id: id,
      p_token: token,
    });
    if (result.error) throw result.error;
    return result.data === true;
  }
  async function release(id: string, token: string) {
    if (demo) {
      releaseDemo(id, token);
      return;
    }
    const result = await supabase!.rpc("release_job_lock", {
      p_job_id: id,
      p_token: token,
    });
    if (result.error) throw result.error;
  }
  async function openJob(job: Job) {
    if (opening) return;
    setOpening(job.id);
    try {
      const token = crypto.randomUUID();
      const acquired = await acquire(job.id, token);
      if (!acquired) {
        setEditor({ job, token: null, readonly: true });
        await refresh();
        return;
      }
      try {
        let fresh = job;
        if (demo) fresh = demoJobs().find((item) => item.id === job.id)!;
        else {
          const result = await supabase!
            .from("jobs")
            .select("*")
            .eq("id", job.id)
            .single();
          if (result.error) throw result.error;
          fresh = result.data as Job;
        }
        setEditor({ job: fresh, token, readonly: false });
        void refresh();
      } catch (openError) {
        await release(job.id, token).catch(() => {});
        throw openError;
      }
    } catch (openError) {
      setError(errorMessage(openError));
    } finally {
      setOpening(null);
    }
  }
  async function closeEditor(refreshAfter = true) {
    if (editor?.job && editor.token) {
      await cleanUnusedUploads(editor.job.id);
      await release(editor.job.id, editor.token).catch(() => {});
    }
    photoUploads.current.clear();
    uncertainPhotoUploads.current.clear();
    setEditor(null);
    if (refreshAfter) void refresh();
  }
  async function cleanUnusedUploads(jobId: string) {
    if (demo || !photoUploads.current.size) return;
    // A failed response can still mean the database committed. Only remove
    // objects after a fresh read confirms that the job does not reference them.
    try {
      const current = await supabase!.from("jobs").select("*").eq("id", jobId).single();
      if (current.error) return;
      const attached = new Set(jobPhotoPaths(current.data as Job));
      const unused = [...photoUploads.current.values()].filter((path) => !attached.has(path));
      if (!unused.length) return;
      const removed = await supabase!.storage.from("job-photos").remove(unused);
      if (!removed.error) {
        for (const [file, path] of photoUploads.current) {
          if (unused.includes(path)) {
            photoUploads.current.delete(file);
            uncertainPhotoUploads.current.delete(file);
          }
        }
      }
    } catch {
      // Keep uncertain uploads available for retry; attached images are never deleted.
    }
  }
  async function saveJob(input: JobInput, newStatus?: Status, photos: File[] = []) {
    if (!editor) return;
    try {
      const validated = validateInput(input, editor.job ? newStatus || editor.job.status : input.status);
      if (!editor.job) {
        const draftId = editor.draftId!;
        if (demo) createDemo(validated, draftId);
        else {
          const result = await supabase!.from("jobs").insert({
            ...validated,
            id: draftId,
            created_by: identity,
            updated_by: identity,
          });
          if (result.error) {
            if (result.error.code !== "23505") throw result.error;
            // A retry after a lost response must not create the measurement twice.
            const existing = await supabase!
              .from("jobs")
              .select("id,created_by")
              .eq("id", draftId)
              .single();
            if (existing.error || existing.data.created_by !== identity)
              throw result.error;
          }
        }
      } else {
        const patch: JobPatch = editor.job.status === "installed" ? {} : { ...validated };
        delete patch.job_kind;
        if (newStatus) patch.status = newStatus;
        if (photos.length) {
          if (newStatus !== "installed" && editor.job.status !== "installed")
            throw new Error("Las fotos se guardan al marcar Colocado.");
          photos.forEach(validatePhoto);
          const addedPaths: string[] = [];
          for (const photo of photos) {
            let photoPath = photoUploads.current.get(photo);
            if (photoPath && uncertainPhotoUploads.current.has(photo) && !demo) {
              const exists = await supabase!.storage.from("job-photos").createSignedUrl(photoPath, 60);
              if (exists.error) {
                const missing = /not found/i.test(exists.error.message) ||
                  ("statusCode" in exists.error && String(exists.error.statusCode) === "404");
                if (!missing) throw exists.error;
                photoUploads.current.delete(photo);
                uncertainPhotoUploads.current.delete(photo);
                photoPath = undefined;
              } else uncertainPhotoUploads.current.delete(photo);
            }
            if (!photoPath) {
              if (demo) {
                photoPath = await shrinkDemoPhoto(photo);
                photoUploads.current.set(photo, photoPath);
              } else {
                const ext = ({
                  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
                  "image/heic": "heic", "image/heif": "heif",
                } as Record<string, string>)[photo.type];
                photoPath = `${editor.job.id}/${crypto.randomUUID()}.${ext}`;
                // Remember the candidate before sending, since the response can be lost.
                photoUploads.current.set(photo, photoPath);
                uncertainPhotoUploads.current.add(photo);
                const result = await supabase!.storage.from("job-photos").upload(photoPath, photo, {
                  upsert: false, contentType: photo.type,
                });
                if (result.error) {
                  throw result.error;
                }
                uncertainPhotoUploads.current.delete(photo);
              }
            }
            addedPaths.push(photoPath);
          }
          patch.photo_paths = appendPhotoPaths(editor.job, addedPaths);
        }
        if ((newStatus || editor.job.status) === "installed" &&
          !(patch.photo_paths || jobPhotoPaths(editor.job)).length)
          throw new Error("Añade al menos una foto antes de marcar Colocado.");
        if (demo)
          updateDemo(editor.job.id, editor.token!, editor.job.version, patch);
        else {
          const result = await supabase!.rpc("update_job", {
            p_job_id: editor.job.id,
            p_token: editor.token,
            p_expected_version: editor.job.version,
            p_patch: patch,
          });
          if (result.error) {
            // Reconcile an uncertain RPC response before reporting failure or
            // cleaning uploaded objects. A retry must not lose a saved gallery.
            const current = await supabase!.from("jobs").select("*").eq("id", editor.job.id).single();
            if (current.error || !photoPatchIsSaved(current.data as Job, patch, editor.job.version))
              throw result.error;
          }
        }
      }
    } catch (saveError) {
      if (editor.job) await cleanUnusedUploads(editor.job.id);
      throw saveError;
    }
    setToast(
      newStatus === "installed"
        ? `Trabajo terminado. ${photos.length === 1 ? "Foto guardada" : "Fotos guardadas"}.`
        : !editor.job
          ? input.job_kind === "dehumidifier" ? "Local registrado. Sus unidades quedan pendientes de colocar." : input.status === "pending_measurement" ? "Local guardado. Queda pendiente de medir." : "Medición guardada. Ya está lista para cortar."
          : editor.job.status === "installed" ? "Fotos añadidas al trabajo." : "Trabajo actualizado.",
    );
    await closeEditor();
  }
  async function reviewJob(action: "approve" | ReworkKind, notes: string) {
    if (!editor?.job || !editor.token) return;
    if (demo) reviewDemo(editor.job.id, editor.token, editor.job.version, action, notes);
    else {
      const result = await supabase!.rpc("review_job", {
        p_job_id: editor.job.id,
        p_token: editor.token,
        p_expected_version: editor.job.version,
        p_action: action,
        p_notes: notes,
      });
      if (result.error) {
        const current = await supabase!.from("jobs").select("*").eq("id", editor.job.id).single();
        if (current.error || !reviewPatchIsSaved(current.data as Job, editor.job, action, notes)) throw result.error;
      }
    }
    setToast(action === "approve" ? "Felpudo revisado. Todo correcto." : "Corrección registrada. El trabajo vuelve a pendientes y conserva su historial.");
    await closeEditor();
  }
  async function signOut() {
    refreshGeneration.current += 1;
    refreshInFlight.current = false;
    await closeEditor(false);
    if (demo) setDemo(false);
    else {
      const result = await supabase!.auth.signOut();
      if (result.error) {
        setError(errorMessage(result.error));
        return;
      }
    }
    setJobs([]);
    setProfiles([]);
    setLocks([]);
    setError("");
    setLastSync(null);
  }
  if (!authReady)
    return (
      <div className="loading-page">
        <LoaderCircle className="spin" /> Abriendo tu equipo…
      </div>
    );
  if (!identity)
    return (
      <Login
        onDemo={() => {
          setDemo(true);
          setError("");
        }}
        error={error}
      />
    );

  const kindJobs = jobs.filter((job) => jobKind(job) === kind);
  const listStatuses = kind === "dehumidifier"
    ? STATUSES.filter((item) => ["pending_installation", "installed"].includes(item.id))
    : STATUSES.filter((item) => item.id !== "pending_installation");
  const filtered = sortJobsForWorkspace(kindJobs.filter((job) => matchesJob(job, {
    status: filter,
    material: kind === "mat" ? materialFilter : "all",
    thickness: kind === "mat" ? thicknessFilter : "all",
    responsible: responsibleFilter,
    search,
  }) && (kind !== "mat" || reviewFilter === "all" || ((job.review_status || "pending") === reviewFilter && (reviewFilter === "needs_adjustment" || job.status === "installed")))));
  const materialOptions = getMaterialOptions(kindJobs, MATERIALS);
  const responsibleOptions = getResponsibleOptions(kindJobs, profiles);
  if (responsibleFilter !== "all" && !responsibleOptions.some((item) => item.value === responsibleFilter)) {
    responsibleOptions.push({ value: responsibleFilter, label: responsibleFilter.replace(/^responsible:/, "") });
  }
  if (materialFilter !== "all" && !materialOptions.some((item) => item.value === materialFilter)) {
    materialOptions.push({ value: materialFilter, label: materialFilter.replace(/^other:/, "") });
  }
  const filtersActive = !!search.trim() || filter !== "all" || (kind === "mat" && (materialFilter !== "all" || thicknessFilter !== "all" || reviewFilter !== "all")) || responsibleFilter !== "all";
  async function downloadReport() {
    if (exporting || !filtered.length) return;
    setExporting(true);
    setError("");
    try {
      const { exportReport } = await import("./lib/reports.mjs");
      await exportReport(filtered, kind, async (paths) => {
        if (demo) return Object.fromEntries(paths.map((path) => [path, path]));
        if (!paths.length) return {};
        const result = await supabase!.storage.from("job-photos").createSignedUrls(paths, 3600);
        if (result.error) throw result.error;
        return Object.fromEntries((result.data || []).flatMap((item) => item.path && item.signedUrl ? [[item.path, item.signedUrl]] : []));
      }, import.meta.env.BASE_URL);
      setToast("Informe descargado con los trabajos de esta selección.");
    } catch (reportError) { setError(errorMessage(reportError)); }
    finally { setExporting(false); }
  }
  function clearFilters() {
    setSearch("");
    setFilter("all");
    setMaterialFilter("all");
    setThicknessFilter("all");
    setResponsibleFilter("all");
    setReviewFilter("all");
  }
  function changeKind(nextKind: JobKind) {
    if (kind === nextKind) return;
    sectionFilters.current[kind] = { status: filter, material: materialFilter, responsible: responsibleFilter, thickness: thicknessFilter, search, review: reviewFilter };
    const saved = sectionFilters.current[nextKind];
    setKind(nextKind);
    setFilter(saved?.status || "all");
    setMaterialFilter(saved?.material || "all");
    setResponsibleFilter(saved?.responsible || "all");
    setThicknessFilter(saved?.thickness || "all");
    setSearch(saved?.search || "");
    setReviewFilter(saved?.review || "all");
  }
  function newJob() {
    setEditor({ job: null, token: null, readonly: false, draftId: crypto.randomUUID(), kind });
  }
  const pending = kindJobs.filter((job) => job.status !== "installed").length;
  const units = (items: Job[]) => items.reduce((total, job) => total + job.quantity, 0);
  const metricTiles = kind === "dehumidifier" ? [
    { id: "all", label: "Unidades previstas", count: units(kindJobs), Icon: AirVent },
    { id: "pending_installation", label: "Por colocar", count: units(kindJobs.filter((job) => job.status !== "installed")), Icon: Clock3 },
    { id: "installed", label: "Colocadas", count: units(kindJobs.filter((job) => job.status === "installed")), Icon: CheckCheck },
  ] : listStatuses.filter(({ id }) => !["pending_measurement", "pending_adjustment"].includes(id) || kindJobs.some((job) => job.status === id)).map(({ id, label }) => ({
    id, label, count: kindJobs.filter((job) => job.status === id).length, Icon: icons[id],
  }));
  const person = (id: string) =>
    id
      ? profiles.find((item) => item.id === id)?.display_name ||
        "Usuario anterior"
      : "Sin registrar";
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <Brand />
          <nav aria-label="Navegación principal">
            <button
              className={tab === "jobs" ? "nav-active" : ""}
              onClick={() => setTab("jobs")}
            >
              <ClipboardList size={18} />
              Trabajos
            </button>
            <button
              className={tab === "team" ? "nav-active" : ""}
              onClick={() => setTab("team")}
            >
              <Users size={18} />
              Equipo
            </button>
            <button
              className={tab === "help" ? "nav-active" : ""}
              onClick={() => setTab("help")}
            >
              <Info size={18} />
              <span>Cómo funciona</span>
            </button>
          </nav>
          <button className="user-menu" onClick={signOut} title="Cerrar sesión">
            <span className="avatar">
              {(profile?.display_name || "U").slice(0, 1)}
            </span>
            <span className="user-name">
              {profile?.display_name?.split(" ")[0] || "Mi cuenta"}
            </span>
            <LogOut size={17} />
            <span className="sr-only">Cerrar sesión</span>
          </button>
        </div>
      </header>
      {demo && (
        <div className="demo-banner">
          <span>VISTA DE EJEMPLO</span> Datos de prueba guardados solo en este
          navegador.{" "}
          <button onClick={signOut}>
            Salir del ejemplo <X size={14} />
          </button>
        </div>
      )}
      <main className="main-content">
        {!online && (
          <div className="error-banner" role="alert">
            Sin conexión. Los cambios se guardarán cuando recuperes la red y
            pulses Guardar.
          </div>
        )}
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => void refresh()}>Reintentar</button>
          </div>
        )}
        {tab === "jobs" && (
          <>
            <div className="work-kind-tabs" role="group" aria-label="Tipo de trabajo">
              <button className={kind === "mat" ? "selected" : ""} aria-pressed={kind === "mat"} onClick={() => changeKind("mat")}><Ruler size={18} />Felpudos</button>
              <button className={kind === "dehumidifier" ? "selected" : ""} aria-pressed={kind === "dehumidifier"} onClick={() => changeKind("dehumidifier")}><AirVent size={18} />Deshumidificadores</button>
            </div>
            <section className="page-heading">
              <div>
                <p className="eyebrow">
                  {kind === "mat" ? "DE LA MEDIDA A LA REVISIÓN" : "CADA APARATO EN SU LOCAL"}
                </p>
                <h1>
                  Todo en su sitio<span>.</span>
                </h1>
                <p className="subtitle">
                  {kind === "mat" ? "Mide, corta, coloca y revisa. Tu equipo, al día." : "Registra las unidades, colócalas y añade sus fotos."}
                </p>
              </div>
              <button
                className="primary new-job"
                onClick={newJob}
                disabled={!online || (!demo && !profile?.active)}
              >
                <Plus size={20} />
                {kind === "mat" ? "Nuevo felpudo" : "Registrar deshumidificadores"}
              </button>
            </section>
            <section className={`status-grid ${metricTiles.length > 3 ? "expanded-status-grid" : ""}`} aria-label={kind === "mat" ? "Filtrar por estado de felpudos" : "Unidades de deshumidificadores"}>
              {metricTiles.map(({ id, label, count, Icon }) => {
                return (
                  <button
                    key={id}
                    className={`status-tile ${id} ${filter === id ? "selected" : ""}`}
                    aria-pressed={filter === id}
                    onClick={() => setFilter(filter === id ? "all" : id as Status | "all")}
                  >
                    <div className="tile-top">
                      <span className="status-icon">
                        <Icon size={20} />
                      </span>
                      <ArrowRight size={17} />
                    </div>
                    <div className="tile-bottom">
                      <span>
                        {label}
                      </span>
                      <strong>{count.toString().padStart(2, "0")}</strong>
                    </div>
                  </button>
                );
              })}
            </section>
            <section className="work-section">
              <div className="list-heading">
                <div>
                  <h2>
                    {filter === "all"
                      ? kind === "mat" ? "Los felpudos" : "Los locales"
                      : statusLabel(filter)}
                    <span>{filtered.length}</span>
                  </h2>
                  <p>
                    {pending === 1
                      ? "1 trabajo en marcha"
                      : `${pending} trabajos en marcha`}
                  </p>
                </div>
                <div className="sync-info">
                  <span className={`sync-dot ${!online ? "offline" : ""}`} />
                  <span>
                    {lastSync
                      ? `Actualizado ${lastSync.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}`
                      : "Conectando…"}
                    <small>Cada 2 minutos</small>
                  </span>
                  <button
                    className="icon-button"
                    onClick={() => void refresh()}
                    aria-label="Actualizar trabajos"
                    disabled={refreshing}
                  >
                    <RefreshCw size={16} className={refreshing ? "spin" : ""} />
                  </button>
                </div>
              </div>
              <div className="list-toolbar">
                <button className="button report-button" onClick={() => void downloadReport()} disabled={exporting || !filtered.length || (!demo && !online)}>
                  {exporting ? <LoaderCircle size={17} className="spin" /> : <Download size={17} />}
                  {exporting ? "Preparando informe…" : "Exportar informe"}
                </button>
                <label className="search-box">
                  <Search size={18} />
                  <input
                    placeholder="Buscar por nombre o número de local…"
                    aria-label="Buscar trabajos"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                  {search && (
                    <button
                      className="icon-button"
                      onClick={() => setSearch("")}
                      aria-label="Borrar búsqueda"
                    >
                      <X size={16} />
                    </button>
                  )}
                </label>
                <label className="filter-select">
                  <select
                    aria-label="Estado de los trabajos"
                    value={filter}
                    onChange={(event) =>
                      setFilter(event.target.value as Status | "all")
                    }
                  >
                    <option value="all">Todos los estados</option>
                    {listStatuses.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.short}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={16} />
                </label>
              </div>
              <div className="detail-filters">
                {kind === "mat" && <><label className="filter-field">
                  <span>Material</span>
                  <div className="filter-select">
                    <select
                      aria-label="Filtrar por material"
                      value={materialFilter}
                      onChange={(event) => setMaterialFilter(event.target.value)}
                    >
                      <option value="all">Todos</option>
                      {materialOptions.map((item) => (
                        <option key={item.value} value={item.value}>{item.label}</option>
                      ))}
                    </select>
                    <ChevronDown size={16} />
                  </div>
                </label>
                <label className="filter-field">
                  <span>Espesor</span>
                  <div className="filter-select">
                    <select
                      aria-label="Filtrar por espesor"
                      value={thicknessFilter}
                      onChange={(event) => setThicknessFilter(event.target.value as typeof thicknessFilter)}
                    >
                      <option value="all">Todos</option>
                      <option value="20">20 mm</option>
                      <option value="17">17 mm</option>
                      <option value="unknown">No sé / notas</option>
                    </select>
                    <ChevronDown size={16} />
                  </div>
                </label></>}
                <label className="filter-field filter-responsible">
                  <span>Responsable</span>
                  <div className="filter-select">
                    <select
                      aria-label="Filtrar por responsable"
                      value={responsibleFilter}
                      onChange={(event) => setResponsibleFilter(event.target.value)}
                    >
                      <option value="all">Todos</option>
                      {responsibleOptions.map((item) => (
                        <option key={item.value} value={item.value}>{item.label}</option>
                      ))}
                    </select>
                    <ChevronDown size={16} />
                  </div>
                </label>
                {kind === "mat" && <label className="filter-field filter-review">
                  <span>Revisión</span>
                  <div className="filter-select">
                    <select aria-label="Filtrar por revisión" value={reviewFilter} onChange={(event) => setReviewFilter(event.target.value)}>
                      <option value="all">Todas</option>
                      <option value="pending">Pendiente revisar</option>
                      <option value="approved">Revisado</option>
                      <option value="needs_adjustment">Corrección pendiente</option>
                    </select><ChevronDown size={16} />
                  </div>
                </label>}
                {filtersActive && (
                  <button className="clear-filters" onClick={clearFilters}>
                    <X size={15} /> Limpiar filtros
                  </button>
                )}
              </div>
              {kind === "mat" && thicknessFilter === "unknown" && (
                <p className="filter-help">Incluye espesores sin indicar y valores diferentes de 17/20 mm guardados en las notas.</p>
              )}
              {initialLoading ? (
                <div className="empty-state">
                  <LoaderCircle className="spin" />
                  <h3>Cargando trabajos…</h3>
                </div>
              ) : filtered.length === 0 ? (
                <div className="empty-state">
                  <Ruler size={34} />
                  <h3>
                    {filtersActive
                      ? "No hay trabajos con este filtro"
                      : kind === "mat" ? "El primer felpudo empieza aquí" : "Registra el primer local"}
                  </h3>
                  <p>
                    {filtersActive
                      ? "Prueba otra búsqueda o limpia los filtros."
                      : kind === "mat" ? "Añade una tienda. Puedes guardar sus medidas ahora o dejarlas pendientes." : "Indica cuántos aparatos necesita la tienda para que el equipo pueda colocarlos."}
                  </p>
                  <button
                    className="secondary"
                    onClick={() => {
                      if (filtersActive) clearFilters();
                      else newJob();
                    }}
                  >
                    {filtersActive
                      ? "Ver todos"
                      : kind === "mat" ? "Nuevo felpudo" : "Registrar local"}
                  </button>
                </div>
              ) : (
                <div className="job-grid">
                  {filtered.map((job) => (
                    <JobCard
                      key={job.id}
                      job={job}
                      lock={locks.find(
                        (lock) =>
                          lock.job_id === job.id &&
                          Date.parse(lock.expires_at) > Date.now(),
                      )}
                      person={person}
                      onOpen={() => void openJob(job)}
                      opening={opening === job.id}
                    />
                  ))}
                </div>
              )}
            </section>
            <div className="workflow-note">
              <ShieldCheck size={18} />
              <span>
                Un trabajo, una persona editando. Los cambios se guardan para
                todo el equipo.
              </span>
            </div>
          </>
        )}
        {tab === "team" && (
          <>
            <section className="page-heading">
              <div>
                <p className="eyebrow">TRABAJAMOS MEJOR JUNTOS</p>
                <h1>
                  Tu equipo<span>.</span>
                </h1>
                <p className="subtitle">
                  Hasta cinco personas conectadas al mismo trabajo.
                </p>
              </div>
              <span className="team-counter">
                <Users size={20} />
                {profiles.filter((item) => item.active).length} / 5 usuarios
              </span>
            </section>
            <div className="team-grid">
              {profiles.map((item) => (
                <div className="team-card" key={item.id}>
                  <span className="avatar large">
                    {item.display_name.slice(0, 1)}
                  </span>
                  <div>
                    <h3>{item.display_name}</h3>
                    <p>
                      {item.role === "admin"
                        ? "Administrador/a"
                        : "Miembro del equipo"}
                      {item.id === identity && " · Tú"}
                    </p>
                  </div>
                  <span
                    className={`member-state ${item.active ? "" : "inactive"}`}
                  >
                    {item.active ? "Activo" : "Inactivo"}
                  </span>
                </div>
              ))}
            </div>
            <div className="help-card">
              <ShieldCheck />
              <div>
                <h3>Acceso solo para tu equipo</h3>
                <p>
                  Entra con tu usuario o correo y contraseña. La aplicación
                  admite hasta cinco usuarios activos que comparten los trabajos.
                </p>
                {demo && (
                  <p>
                    Las personas de esta vista son de ejemplo. Tus cinco
                    usuarios se añadirán al conectar Supabase.
                  </p>
                )}
              </div>
            </div>
          </>
        )}
        {tab === "help" && (
          <>
            <section className="page-heading">
              <div>
                <p className="eyebrow">ASÍ DE SENCILLO</p>
                <h1>
                  De la medida a la foto<span>.</span>
                </h1>
                <p className="subtitle">
                  Felpudos y deshumidificadores, con fotos e información para todo el equipo.
                </p>
              </div>
            </section>
            <div className="guide-grid">
              {[
                {
                  icon: Ruler,
                  title: "01 · Mide en la tienda",
                  text: "En Felpudos, pulsa Nuevo felpudo. Cada trabajo es una pieza. Escribe el local y sus medidas en centímetros, o guarda el local para medirlo después.",
                },
                {
                  icon: Scissors,
                  title: "02 · Prepara el corte",
                  text: "Abre un trabajo Medido. Cuando hayas cortado el felpudo, pulsa Marcar cortado.",
                },
                {
                  icon: Camera,
                  title: "03 · Coloca y añade las fotos",
                  text: "Abre un trabajo Cortado. Coloca el felpudo, añade al menos una foto y pulsa Marcar colocado. Puedes añadir más fotos, también después. La tarjeta quedará verde y al final de la lista.",
                },
              ].map((item) => (
                <div className="guide-card" key={item.title}>
                  <item.icon size={30} />
                  <h3>{item.title}</h3>
                  <p>{item.text}</p>
                </div>
              ))}
            </div>
            <div className="help-card">
              <ShieldCheck />
              <div><h3>Revisa la colocación</h3><p>Abre un felpudo colocado y pulsa Está bien si está correcto. Si necesita una corrección, elige Recortar, Añadir una parte o Reponer entero y describe el problema. El trabajo vuelve a pendientes. Las fotos anteriores se conservan en el historial y la corrección necesita fotos nuevas.</p></div>
            </div>
            <div className="help-card">
              <AirVent />
              <div><h3>Deshumidificadores: unidades y colocación</h3><p>En Deshumidificadores, registra el local y cuántos aparatos necesita. Las métricas cuentan unidades previstas, por colocar y colocadas. Coloca todos los aparatos de ese local, añade al menos una foto y marca Colocado.</p></div>
            </div>
            <div className="help-card">
              <LockKeyhole />
              <div>
                <h3>Nadie pisa el trabajo de otra persona</h3>
                <p>
                  Al abrir un trabajo para editarlo, se reserva para ti. Se
                  libera al guardar o cerrar. Si la app se cierra, se libera
                  automáticamente en un máximo de tres minutos. Si caduca,
                  vuelve a abrir el trabajo antes de guardar.
                </p>
              </div>
            </div>
            <div className="help-card">
              <RefreshCw />
              <div>
                <h3>Información al día</h3>
                <p>
                  Los datos se actualizan cada dos minutos y al volver a la app.
                  La actualización conserva las medidas y las fotos que estés
                  preparando. Necesitas conexión para guardar.
                </p>
              </div>
            </div>
            <div className="help-card">
              <Plus />
              <div>
                <h3>Añádela a la pantalla de inicio</h3>
                <p>
                  En iPhone: Safari → Compartir → Añadir a pantalla de inicio.
                  En Android: abre el menú del navegador → Añadir a pantalla de
                  inicio.
                </p>
              </div>
            </div>
          </>
        )}
        <footer className="footer">
          <span className="footer-brand"><AppLogo />CONTROL DE TRABAJOS</span>
          <span>{kind === "mat" ? "Medir bien. Cortar una vez." : "Cada aparato en su local."}</span>
        </footer>
      </main>
      {editor && (
        <JobEditor
          key={editor.job?.id || "new"}
          state={editor}
          onClose={closeEditor}
          onSave={saveJob}
          onReview={reviewJob}
          acquire={acquire}
          person={person}
          profiles={profiles}
          currentName={profile?.display_name || ""}
          lock={locks.find((lock) => lock.job_id === editor.job?.id)}
          demo={demo}
          online={online}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={19} />
          {toast}
        </div>
      )}
    </div>
  );
}

function Login({ onDemo, error }: { onDemo: () => void; error: string }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  function changeMode(nextMode: "login" | "register") {
    setMode(nextMode);
    setMessage("");
    setNotice("");
    setShowPassword(false);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setMessage("");
    setNotice("");
    try {
      const identifier = String(form.get("email")).trim();
      const email = mode === "register" ? identifier : resolveLoginEmail(identifier);
      const password = String(form.get("password"));
      if (mode === "register") {
        const name = String(form.get("display_name")).trim();
        if (!name)
          throw new Error(
            "Escribe tu nombre para que el equipo te identifique.",
          );
        if (password.length < 8)
          throw new Error("La contraseña debe tener al menos ocho caracteres.");
        if (password !== String(form.get("password_confirmation")))
          throw new Error("Las contraseñas no coinciden.");
        const result = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { display_name: name },
            emailRedirectTo: new URL(".", window.location.href).href,
          },
        });
        if (result.error) throw result.error;
        if (!result.data.session)
          setNotice(
            "Si este correo no tenía una cuenta, recibirás un enlace para confirmarla. Revisa también la carpeta de spam. Si ya tienes cuenta, inicia sesión.",
          );
      } else {
        const result = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (result.error) throw result.error;
      }
    } catch (loginError) {
      setMessage(errorMessage(loginError));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <header>
        <Brand />
      </header>
      <main className="login-main">
        <div className="login-intro">
          <p className="eyebrow">TU EQUIPO. CADA TIENDA. TODO AL DÍA.</p>
          <h1>
            El trabajo bien hecho empieza por una buena medida<span>.</span>
          </h1>
          <p>
            Felpudos y deshumidificadores, de principio a fin.
            <br />
            Un sitio para coordinar todo el trabajo.
          </p>
          <div className="login-flow">
            <span>
              <Ruler />
              Medir
            </span>
            <ArrowRight size={18} />
            <span>
              <Scissors />
              Cortar
            </span>
            <ArrowRight size={18} />
            <span>
              <Camera />
              Colocar
            </span>
          </div>
          <div className="mat-illustration" aria-hidden="true">
            <div className="mat-label">
              120 <span>cm</span>
              <ArrowRight size={14} />
            </div>
            <div className="mat-art">
              <span>BIENVENIDO</span>
            </div>
            <div className="mat-length">
              180 cm <ArrowDown size={14} />
            </div>
            <span className="illustration-caption">CADA CENTÍMETRO CUENTA</span>
          </div>
        </div>
        <div className="login-card">
          <span className="login-lock">
            <AppLogo />
          </span>
          <h2>{mode === "register" ? "Crea tu cuenta." : "Hola, equipo."}</h2>
          <p>
            {mode === "register"
              ? "Únete al equipo y empieza a trabajar."
              : "Entra para continuar con tus trabajos."}
          </p>
          {supabase ? (
            <form onSubmit={submit} key={mode}>
              {mode === "register" && (
                <label>
                  Tu nombre
                  <input
                    name="display_name"
                    autoComplete="name"
                    placeholder="Cómo te llama el equipo"
                    maxLength={100}
                    disabled={busy}
                    required
                  />
                </label>
              )}
              <label>
                {mode === "register" ? "Correo electrónico" : "Correo o usuario"}
                <input
                  type={mode === "register" ? "email" : "text"}
                  name="email"
                  autoComplete="username"
                  placeholder={mode === "register" ? "tu@correo.com" : "Ej. andres o tu@correo.com"}
                  disabled={busy}
                  required
                />
              </label>
              <label>
                Contraseña
                <div className="password-field">
                  <input
                    type={showPassword ? "text" : "password"}
                    name="password"
                    autoComplete={
                      mode === "register" ? "new-password" : "current-password"
                    }
                    placeholder={
                      mode === "register"
                        ? "Al menos 8 caracteres"
                        : "Tu contraseña"
                    }
                    minLength={mode === "register" ? 8 : undefined}
                    disabled={busy}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={
                      showPassword ? "Ocultar contraseña" : "Mostrar contraseña"
                    }
                  >
                    {showPassword ? "Ocultar" : "Ver"}
                  </button>
                </div>
              </label>
              {mode === "register" && (
                <label>
                  Repite la contraseña
                  <input
                    type={showPassword ? "text" : "password"}
                    name="password_confirmation"
                    autoComplete="new-password"
                    placeholder="La misma contraseña"
                    minLength={8}
                    disabled={busy}
                    required
                  />
                </label>
              )}
              {(message || error) && (
                <div className="form-error" role="alert">
                  {message || error}
                </div>
              )}
              {notice && (
                <div className="auth-notice" role="status">
                  {notice}
                </div>
              )}
              <button className="primary" disabled={busy}>
                {busy ? (
                  <LoaderCircle className="spin" size={18} />
                ) : (
                  <>
                    {mode === "register" ? "Crear cuenta" : "Entrar"}{" "}
                    <ArrowRight size={18} />
                  </>
                )}
              </button>
              <div className="auth-switch">
                <span>
                  {mode === "register"
                    ? "¿Ya tienes cuenta?"
                    : "¿Es tu primera vez?"}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    changeMode(mode === "register" ? "login" : "register")
                  }
                >
                  {mode === "register" ? "Iniciar sesión" : "Registrarme"}
                </button>
              </div>
              <small>
                {mode === "register"
                  ? "El equipo admite hasta cinco cuentas."
                  : "Para recuperar tu contraseña, contacta con quien administra tu equipo."}
              </small>
            </form>
          ) : (
            <div className="setup-notice">
              <Info size={20} />
              <div>
                <strong>Tu aplicación está preparada</strong>
                <p>
                  Falta conectar el proyecto de Supabase para activar el acceso
                  del equipo. Mientras tanto, puedes recorrer un ejemplo.
                </p>
              </div>
            </div>
          )}
          <button className="demo-link" onClick={onDemo}>
            Ver la aplicación de ejemplo <ArrowRight size={16} />
          </button>
          <div className="login-footnote">
            <ShieldCheck size={15} /> Equipo de hasta 5 usuarios
          </div>
        </div>
      </main>
      <footer className="login-footer">
        <span className="footer-brand"><AppLogo />CONTROL DE TRABAJOS</span>
        <span>MEDIR · CORTAR · COLOCAR</span>
      </footer>
    </div>
  );
}

function JobCard({
  job,
  lock,
  person,
  onOpen,
  opening,
}: {
  job: Job;
  lock?: JobLock;
  person: (id: string) => string;
  onOpen: () => void;
  opening: boolean;
}) {
  const Icon = icons[job.status];
  const stages = getJobStages(job);
  const step = stages.findIndex((item: { id: Status }) => item.id === job.status);
  const device = jobKind(job) === "dehumidifier";
  return (
    <article className={`job-card ${job.status}`}>
      <div className="card-top">
        <span className={`status-pill ${job.status}`}>
          <span />
          {statusLabel(job.status)}
        </span>
        <span className="job-number">
          #
          {job.id.startsWith("demo-job")
            ? `00${Number(job.id.slice(-1)) + 1}`
            : job.id.slice(0, 5).toUpperCase()}
        </span>
      </div>
      <div className="job-title">
        <h3>{job.store_name}</h3>
        <span className="job-responsible">
          <Users size={12} />
          <span>Responsable: {job.responsible_name?.trim() || "Sin asignar"}</span>
        </span>
      </div>
      {!device && (job.status === "installed" || job.review_status === "needs_adjustment") && <div className="job-review-badges">
        <span className={`review-badge ${job.review_status || "pending"}`}><ShieldCheck size={13} />{reviewLabels[job.review_status || "pending"]}</span>
        {job.rework_kind && job.status !== "installed" && <span className="rework-badge">{reworkLabels[job.rework_kind]}</span>}
      </div>}
      {device ? <div className="device-quantity-panel"><AirVent size={26} /><strong>{job.quantity}</strong><span>{job.quantity === 1 ? "deshumidificador" : "deshumidificadores"}<small>{job.status === "installed" ? "Colocados en este local" : "Pendientes de colocar en este local"}</small></span></div> : <>
      {job.rework_kind === "add" && <p className="measure-caption">MEDIDAS DE LA PARTE AÑADIDA</p>}
      <div className="measure-panel">
        <div>
          <small>ANCHO</small>
          <strong>
            {job.width_cm == null ? "—" : format(job.width_cm)}
            <span> cm</span>
          </strong>
        </div>
        <span className="measure-times">×</span>
        <div>
          <small>LARGO</small>
          <strong>
            {job.length_cm == null ? "—" : format(job.length_cm)}
            <span> cm</span>
          </strong>
        </div>
        <span className="mini-mat" aria-hidden="true" />
      </div>
      <div className="material-line">
        <span>
          {MATERIALS.find((item) => item.value === job.material)?.label ||
            job.material || "Material sin especificar"}
          <small>
            Espesor: {job.thickness_mm == null ? "No sé" : `${job.thickness_mm} mm`}
          </small>
        </span>
      </div>
      </>}
      <div className="card-progress" aria-label={`Paso ${step + 1} de ${stages.length}`}>
        {stages.map((item: { id: Status }, index: number) => (
          <span className={index <= step ? "done" : ""} key={item.id} />
        ))}
      </div>
      <div className="card-meta">
        <span>
          <Clock3 size={13} />
          {dateTime(job.updated_at)}
        </span>
        <span className="person-label">
          <span className="avatar tiny">
            {person(job.updated_by).slice(0, 1)}
          </span>
          {person(job.updated_by).split(" ")[0]}
        </span>
      </div>
      {lock && (
        <p className="lock-info">
          <LockKeyhole size={13} />
          {person(lock.user_id)} está editando
        </p>
      )}
      <button className="card-action" onClick={onOpen} disabled={opening}>
        {opening ? (
          <>
            <LoaderCircle size={16} className="spin" />
            Abriendo…
          </>
        ) : (
          <>
            <Icon size={17} />
            {job.status === "installed"
              ? "Ver trabajo terminado"
              : lock
                ? "Consultar trabajo"
                : "Abrir trabajo"}
            <ArrowRight size={17} />
          </>
        )}
      </button>
    </article>
  );
}

function JobEditor({
  state,
  onClose,
  onSave,
  onReview,
  acquire,
  person,
  profiles,
  currentName,
  lock,
  demo,
  online,
}: {
  state: EditorState;
  onClose: () => Promise<void>;
  onSave: (input: JobInput, status?: Status, photos?: File[]) => Promise<void>;
  onReview: (action: "approve" | ReworkKind, notes: string) => Promise<void>;
  acquire: (id: string, token: string) => Promise<boolean>;
  person: (id: string) => string;
  profiles: Profile[];
  currentName: string;
  lock?: JobLock;
  demo: boolean;
  online: boolean;
}) {
  const job = state.job;
  const kind = job ? jobKind(job) : state.kind || "mat";
  const device = kind === "dehumidifier";
  const stages = getJobStages(job || kind);
  const [preparedNotes] = useState(() => prepareJobNotes(job));
  const [values, setValues] = useState({
    store_name: job?.store_name || "",
    width: String(job?.width_cm || ""),
    length: String(job?.length_cm || ""),
    thickness: String(job?.thickness_mm ?? ""),
    material: job ? job.material : "coco",
    responsible_name: job ? job.responsible_name ?? "" : currentName,
    notes: preparedNotes.notes,
    quantity: String(job?.quantity || 1),
  });
  const activeResponsibleNames = [
    ...new Set(
      profiles
        .filter((item) => item.active)
        .map((item) => item.display_name.trim())
        .filter(Boolean),
    ),
  ];
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState("");
  const [photos, setPhotos] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [savedPhotos, setSavedPhotos] = useState<{ path: string; url: string }[]>([]);
  const [photoError, setPhotoError] = useState("");
  const [reviewAction, setReviewAction] = useState<ReworkKind | "">("");
  const [reviewNotes, setReviewNotes] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const photoSectionRef = useRef<HTMLElement>(null);
  const deadline = useRef(Date.now() + 180000);
  const renewInFlight = useRef(false);
  const canEdit = !state.readonly && !expired;
  const detailsEditable = canEdit && job?.status !== "installed" && !busy;
  const measurementsEditable = detailsEditable && (!job || ["pending_measurement", "measured"].includes(job.status));
  const photoPaths = jobPhotoPaths(job);
  const photoPathsKey = JSON.stringify(photoPaths);

  useEffect(() => {
    const dialog = dialogRef.current!;
    const previousFocus = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    const updateViewport = () => {
      const viewport = window.visualViewport;
      dialog.style.setProperty("--editor-viewport-height", `${viewport?.height || window.innerHeight}px`);
      dialog.style.setProperty("--editor-viewport-top", `${viewport?.offsetTop || 0}px`);
    };
    updateViewport();
    dialog.showModal();
    document.body.style.overflow = "hidden";
    bodyRef.current?.scrollTo(0, 0);
    dialog.querySelector<HTMLButtonElement>(".dialog-header button")?.focus({ preventScroll: true });
    window.visualViewport?.addEventListener("resize", updateViewport);
    window.visualViewport?.addEventListener("scroll", updateViewport);
    window.addEventListener("resize", updateViewport);
    return () => {
      window.visualViewport?.removeEventListener("resize", updateViewport);
      window.visualViewport?.removeEventListener("scroll", updateViewport);
      window.removeEventListener("resize", updateViewport);
      document.body.style.overflow = oldOverflow;
      dialog.close();
      previousFocus?.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (!job || !state.token) return;
    let live = true;
    async function renew() {
      if (renewInFlight.current) return;
      renewInFlight.current = true;
      try {
        const renewed = await acquire(job!.id, state.token!);
        if (live) {
          if (renewed) deadline.current = Date.now() + 180000;
          else setExpired(true);
        }
      } catch {
        if (live && Date.now() >= deadline.current) setExpired(true);
      } finally {
        renewInFlight.current = false;
      }
    }
    const timer = window.setInterval(() => void renew(), 45000);
    const expiryTimer = window.setInterval(() => {
      if (Date.now() >= deadline.current) setExpired(true);
    }, 1000);
    const visible = () => {
      if (document.visibilityState === "visible") {
        if (Date.now() >= deadline.current) setExpired(true);
        else void renew();
      }
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      live = false;
      clearInterval(timer);
      clearInterval(expiryTimer);
      document.removeEventListener("visibilitychange", visible);
    };
    // The editor keeps its original job version and does not reset its form on polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, state.token]);
  useEffect(() => {
    const urls = photos.map((photo) => URL.createObjectURL(photo));
    setPreviews(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [photos]);
  useEffect(() => {
    if (!photoPaths.length) {
      setSavedPhotos([]);
      return;
    }
    let live = true;
    async function loadPhotos() {
      if (demo) {
        setSavedPhotos(photoPaths.map((path) => ({ path, url: path })));
        return;
      }
      try {
        const results = await Promise.all(photoPaths.map(async (path) => {
          const result = await supabase!.storage.from("job-photos").createSignedUrl(path, 3600);
          return { path, result };
        }));
        if (live) {
          setSavedPhotos(results.flatMap(({ path, result }) =>
            result.data ? [{ path, url: result.data.signedUrl }] : []));
          const failed = results.find(({ result }) => result.error);
          setPhotoError(failed ? "No se han podido cargar todas las fotos. Cierra y vuelve a abrir la ficha para reintentar." : "");
        }
      } catch (loadError) {
        if (live) setPhotoError(errorMessage(loadError));
      }
    }
    void loadPhotos();
    const timer = window.setInterval(() => void loadPhotos(), 120000);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // The paths are represented by a stable string so renewals do not reset selections.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoPathsKey, demo]);
  function selectPhotos(files: File[]) {
    const selected = [...photos];
    const invalid: string[] = [];
    for (const file of files) {
      try {
        validatePhoto(file);
        const duplicate = selected.some((existing) => existing.name === file.name &&
          existing.size === file.size && existing.lastModified === file.lastModified && existing.type === file.type);
        if (!duplicate) selected.push(file);
      } catch (validationError) {
        invalid.push(`${file.name}: ${errorMessage(validationError)}`);
      }
    }
    setPhotos(selected);
    setError(invalid.join(" "));
    setPhotoError("");
  }
  async function save(status?: Status) {
    if (busy || !canEdit) return;
    setError("");
    setBusy(true);
    try {
      if (!online)
        throw new Error(
          "Necesitas conexión para guardar. Tus datos siguen aquí.",
        );
      if (status === "installed" && !photos.length && !photoPaths.length) {
        photoSectionRef.current?.scrollIntoView({ block: "nearest" });
        document.getElementById("job-photo")?.focus({ preventScroll: true });
        throw new Error(device ? "Te falta añadir al menos una foto de los aparatos colocados. Las unidades siguen pendientes." : job?.rework_kind ? "Añade al menos una foto nueva de la corrección terminada. Las fotos anteriores siguen en el historial." : "Te falta hacer o añadir al menos una foto del felpudo colocado. El trabajo sigue pendiente.");
      }
      const width = device || !values.width.trim() ? null : parseMeasure(values.width);
      const length = device || !values.length.trim() ? null : parseMeasure(values.length);
      if (!device && (width == null) !== (length == null)) throw new Error("Completa las dos medidas, o deja ambas vacías para medir más tarde.");
      if (!device && status === "measured" && (width == null || length == null)) throw new Error("Añade las dos medidas antes de marcar Medido.");
      const inputStatus = job ? status || job.status : device ? "pending_installation" : width == null ? "pending_measurement" : "measured";
      await onSave(
        {
          job_kind: kind,
          status: inputStatus,
          store_name: values.store_name,
          address: job?.address || "",
          width_cm: width,
          length_cm: length,
          thickness_mm: device || values.thickness === "" ? null : Number(values.thickness),
          quantity: device ? Number(values.quantity) : 1,
          material: device ? "" : values.material,
          responsible_name: values.responsible_name,
          notes: combineJobNotes(values.notes, preparedNotes),
        },
        status,
        photos,
      );
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setBusy(false);
    }
  }
  async function review(action: "approve" | ReworkKind) {
    if (busy || !canEdit) return;
    setError("");
    if (action !== "approve" && !reviewNotes.trim()) { setError("Indica qué hay que corregir para que el equipo sepa cómo continuar."); return; }
    if (photos.length) { setError("Guarda las fotos preparadas antes de registrar la revisión."); return; }
    setBusy(true);
    try {
      if (!online) throw new Error("Necesitas conexión para guardar la revisión.");
      await onReview(action, reviewNotes.trim());
    } catch (reviewError) { setError(errorMessage(reviewError)); }
    finally { setBusy(false); }
  }
  const next = job ? nextStatus(job.status, kind) : null;
  const readyToInstall = job && ["cut", "pending_adjustment", "pending_installation"].includes(job.status);
  return (
    <dialog
      ref={dialogRef}
      className="job-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) void onClose();
      }}
      aria-labelledby="editor-title"
    >
      <div className="dialog-header">
        <div>
          <p className="eyebrow">
            <AppLogo className="editor-logo" />
            {device ? "DESHUMIDIFICADORES" : job ? "FICHA DEL FELPUDO" : "NUEVO FELPUDO"}
          </p>
          <h2 id="editor-title">{job?.store_name || (device ? "Registrar local" : "Nuevo felpudo")}</h2>
        </div>
        <button
          className="icon-button"
          autoFocus
          onClick={() => void onClose()}
          disabled={busy}
          aria-label="Cerrar trabajo"
        >
          <X size={23} />
        </button>
      </div>
      <div className="dialog-body" ref={bodyRef}>
        {job && (
          <div className="editor-steps" style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}>
            {stages.map((item: { id: Status; label: string }, index: number) => {
              const Icon = icons[item.id];
              const done =
                index <=
                stages.findIndex((status: { id: Status }) => status.id === job.status);
              return (
                <div className={done ? "done" : ""} key={item.id}>
                  <span>
                    <Icon size={16} />
                  </span>
                  <small>{item.label}</small>
                </div>
              );
            })}
          </div>
        )}
        {expired ? (
          <div className="form-error" role="alert">
            Tu reserva ha caducado. Tus datos siguen visibles, pero debes cerrar
            y volver a abrir el trabajo antes de guardar.
          </div>
        ) : state.readonly ? (
          <div className="readonly-notice">
            <LockKeyhole size={18} />
            <span>
              {lock
                ? `${person(lock.user_id)} está editando este trabajo.`
                : "Este trabajo está reservado por otra persona."}{" "}
              Puedes consultar sus datos y fotos. Cierra y vuelve a abrir para editar
              cuando esté libre.
            </span>
          </div>
        ) : canEdit && job ? (
          <div className="edit-reserved">
            <ShieldCheck size={16} />
            {job.status === "installed"
              ? "Trabajo reservado para ti mientras añades fotos."
              : "Trabajo reservado para ti mientras lo editas."}
          </div>
        ) : null}
        {job?.rework_kind && job.status !== "installed" && <div className="correction-notice">
          <strong>{reworkLabels[job.rework_kind]} · Corrección {job.revision_no}</strong>
          <p>{job.review_notes}</p>
          <small>{job.rework_kind === "trim" ? "Ajusta el felpudo y añade fotos nuevas para cerrarlo." : job.rework_kind === "add" ? "Mide solo la parte que se añade; después córtala, colócala y añade fotos nuevas." : "Vuelve a medir el local, corta el nuevo felpudo y añade fotos nuevas al colocarlo."}</small>
        </div>}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          id="job-form"
        >
          <label>
            Tienda o local <span>*</span>
            <input
              value={values.store_name}
              onChange={(event) =>
                setValues({ ...values, store_name: event.target.value })
              }
              placeholder="Nombre de la tienda"
              maxLength={140}
              required
              disabled={!detailsEditable}
            />
          </label>
          <label>
            Responsable
            <select
              value={values.responsible_name}
              onChange={(event) =>
                setValues({ ...values, responsible_name: event.target.value })
              }
              disabled={!detailsEditable}
            >
              <option value="">Sin asignar</option>
              {values.responsible_name &&
                !activeResponsibleNames.includes(values.responsible_name) && (
                  <option value={values.responsible_name}>
                    {values.responsible_name} · Guardado
                  </option>
                )}
              {activeResponsibleNames.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
          {device && <label>
            Deshumidificadores que necesita el local <span>*</span>
            <input type="number" inputMode="numeric" min="1" step="1" required
              value={values.quantity} disabled={!detailsEditable}
              onChange={(event) => setValues({ ...values, quantity: event.target.value })}
            />
          </label>}
          {!device && <>
          {job?.rework_kind === "add" && <p className="measure-caption">Medidas de la parte que se añade</p>}
          <div className="measure-form">
            <label>
              Ancho
              <div className="input-unit">
                <input
                  value={values.width}
                  onChange={(event) =>
                    setValues({ ...values, width: event.target.value })
                  }
                  placeholder="120"
                  inputMode="decimal"
                  disabled={!measurementsEditable}
                />
                <span>cm</span>
              </div>
            </label>
            <span className="form-times">×</span>
            <label>
              Largo
              <div className="input-unit">
                <input
                  value={values.length}
                  onChange={(event) =>
                    setValues({ ...values, length: event.target.value })
                  }
                  placeholder="180"
                  inputMode="decimal"
                  disabled={!measurementsEditable}
                />
                <span>cm</span>
              </div>
            </label>
          </div>
          <p className="field-help">
            Medidas en centímetros. Ejemplo: 120,5 × 180 cm.
            {(!job || job.status === "pending_measurement") && " Puedes guardar el local sin medidas y completarlas después."}
            {job &&
              ["cut", "installed", "pending_adjustment"].includes(job.status) &&
              " Las medidas quedan fijadas al marcar Cortado."}
          </p>
          <div className="material-form">
            <label>
              Material
              <select
                value={values.material}
                onChange={(event) =>
                  setValues({ ...values, material: event.target.value })
                }
                disabled={!measurementsEditable}
              >
                {!MATERIALS.some((item) => item.value === values.material) && (
                  <option value={values.material}>
                    {values.material || "Sin especificar"}
                  </option>
                )}
                {MATERIALS.map((item) => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </select>
            </label>
            <label>
              Espesor
              <select
                value={values.thickness}
                onChange={(event) =>
                  setValues({ ...values, thickness: event.target.value })
                }
                disabled={!measurementsEditable}
              >
                <option value="">No sé</option>
                <option value="20">20 mm</option>
                <option value="17">17 mm</option>
              </select>
            </label>
          </div>
          </>}
          <label>
            Observaciones
            <textarea
              value={values.notes}
              onChange={(event) =>
                setValues({ ...values, notes: event.target.value })
              }
              placeholder={device ? "Detalles útiles para colocar los aparatos…" : "Solo lo necesario: datos pendientes, sentido de la fibra…"}
              rows={3}
              maxLength={editableNotesLimit(preparedNotes)}
              disabled={!detailsEditable}
            />
          </label>
          {preparedNotes.archive && (
            <details className="import-history">
              <summary>Ver información original del listado y el chat</summary>
              <p>Referencia de la importación. Las medidas, el material, el espesor y el responsable de esta ficha muestran los datos actuales.</p>
              <pre>{preparedNotes.archive}</pre>
            </details>
          )}
        </form>
        {job && (job.status === "installed" || (readyToInstall && canEdit)) && (
          <section className="photo-section" ref={photoSectionRef}>
            <h3>
              {job.status === "installed" ? <CheckCheck size={20} /> : <Camera size={20} />}
              {job.status === "installed" ? device ? "Deshumidificadores colocados" : "Felpudo colocado" : "Fotos del trabajo colocado"}
              {readyToInstall && <span>*</span>}
            </h3>
            {job.installed_at ? (
              <p>Colocado el {dateTime(job.installed_at)} · {photoPaths.length} {photoPaths.length === 1 ? "foto guardada" : "fotos guardadas"}.</p>
            ) : (
              <p>
                Añade al menos una {job.rework_kind ? "foto nueva cuando la corrección esté terminada" : device ? "foto cuando los aparatos estén colocados" : "foto cuando el felpudo esté en su sitio"}. Las fotos
                adicionales son opcionales y se guardarán al pulsar Marcar colocado.
              </p>
            )}
            {!!savedPhotos.length && (
              <div className="photo-grid saved-photo-grid">
                {savedPhotos.map(({ path, url }, index) => (
                  <a href={url} target="_blank" rel="noreferrer" key={path}>
                    <img className="saved-photo" src={url}
                      alt={`Trabajo colocado en ${job.store_name}, foto ${index + 1}`}
                      onError={() => setPhotoError("No se puede mostrar alguna imagen en este navegador. Pulsa la foto para abrirla.")}
                    />
                    <small>Abrir foto {index + 1}</small>
                  </a>
                ))}
              </div>
            )}
            {!!photoPaths.length && !savedPhotos.length && !photoError && <p>Cargando fotos…</p>}
            {canEdit && (
              <>
                {job.status === "installed" && <p>Puedes añadir más fotos. Las fotos guardadas se conservan.</p>}
                <div className={`photo-actions ${busy ? "is-busy" : ""}`}>
                  <label className="photo-picker" htmlFor="job-photo">
                    <Plus size={25} /><span>Elegir de la galería</span><small>Puedes seleccionar varias</small>
                  </label>
                  <label className="photo-picker" htmlFor="job-camera">
                    <Camera size={25} /><span>Hacer una foto</span><small>Añade otra cuando quieras</small>
                  </label>
                </div>
                <p className="photo-formats">JPG, PNG, WebP o HEIC · Máximo 10 MB por foto</p>
                <input id="job-photo" type="file" className="sr-only"
                  accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple disabled={busy}
                  onChange={(event) => {
                    selectPhotos(Array.from(event.target.files || []));
                    event.target.value = "";
                  }}
                />
                <input id="job-camera" type="file" className="sr-only"
                  accept="image/jpeg,image/png,image/webp,image/heic,image/heif" capture="environment" disabled={busy}
                  onChange={(event) => {
                    selectPhotos(Array.from(event.target.files || []));
                    event.target.value = "";
                  }}
                />
                {!!photos.length && (
                  <>
                    <p className="selected-file" role="status"><Check size={15} />{photos.length} {photos.length === 1 ? "foto preparada" : "fotos preparadas"} para guardar</p>
                    <div className="photo-grid selected-photo-grid">
                      {photos.map((photo, index) => (
                        <figure key={`${photo.name}-${photo.size}-${photo.lastModified}`}>
                          <img src={previews[index]} alt={`Foto seleccionada ${index + 1}: ${photo.name}`}
                            onError={() => setPhotoError("Este navegador no puede previsualizar algún formato. La foto se puede guardar.")}
                          />
                          <button type="button" className="remove-photo" disabled={busy}
                            aria-label={`Quitar foto ${index + 1}: ${photo.name}`}
                            onClick={() => setPhotos((selected) => selected.filter((_, position) => position !== index))}
                          ><X size={18} /></button>
                          <figcaption>{index + 1}. {photo.name}</figcaption>
                        </figure>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </section>
        )}
        {photoError && (
          <p className="form-error" role="alert">
            {photoError}
          </p>
        )}
        {job && !device && job.status === "installed" && <section className="review-section" aria-label="Revisar colocación">
          <h3><ShieldCheck size={20} />Revisar colocación</h3>
          <span className={`review-badge ${job.review_status || "pending"}`}>{reviewLabels[job.review_status || "pending"]}</span>
          {job.reviewed_at && job.review_status === "approved" && <p>Revisado por {person(job.reviewed_by || "")} · {dateTime(job.reviewed_at)}</p>}
          {canEdit && <>
            <button className="secondary approve-review" disabled={busy || !online || job.review_status === "approved"} onClick={() => void review("approve")}><Check size={17} />Está bien</button>
            <details className="correction-picker">
              <summary>Hay que corregirlo</summary>
              <label>Tipo de corrección
                <select value={reviewAction} disabled={busy} onChange={(event) => setReviewAction(event.target.value as ReworkKind | "")}>
                  <option value="">Elige una corrección</option>
                  <option value="trim">Recortar</option>
                  <option value="add">Añadir una parte</option>
                  <option value="replace">Reponer entero</option>
                </select>
              </label>
              {reviewAction && <>
                <p>{reviewAction === "trim" ? "El trabajo vuelve a Por ajustar. Después se cierra con fotos nuevas." : reviewAction === "add" ? "El trabajo vuelve a Por medir. Se miden y cortan las dimensiones de la parte nueva." : "El trabajo vuelve a Por medir para repetir la medición, el corte y la colocación."} Las fotos anteriores se conservarán en el historial.</p>
                <label>Qué hay que corregir <span>*</span><textarea rows={3} maxLength={3000} value={reviewNotes} disabled={busy} onChange={(event) => setReviewNotes(event.target.value)} placeholder="Describe el problema y dónde está…" /></label>
                <button className="primary" disabled={busy || !online} onClick={() => void review(reviewAction)}><RefreshCw size={17} />Reabrir para corregir</button>
              </>}
            </details>
          </>}
        </section>}
        {job && <JobHistory job={job} demo={demo} person={person} />}
        {job && (
          <p className="record-history">
            Registrado por {person(job.created_by)} · {dateTime(job.created_at)}
            {job.measured_at && !device && <><br />Medido por {person(job.measured_by || "")} · {dateTime(job.measured_at)}</>}
            {job.cut_at && (
              <>
                <br />
                Cortado por {person(job.cut_by || "")} · {dateTime(job.cut_at)}
              </>
            )}
            {job.installed_at && (
              <>
                <br />
                Colocado por {person(job.installed_by || "")} ·{" "}
                {dateTime(job.installed_at)}
              </>
            )}
            <br />
            Último cambio: {person(job.updated_by)} · {dateTime(job.updated_at)}
          </p>
        )}
      </div>
      {error && (
        <div className="dialog-error form-error" role="alert">{error}</div>
      )}
      <div className="dialog-footer">
        {!canEdit ? (
          <button className="secondary" onClick={() => void onClose()} disabled={busy}>
            Cerrar ficha
          </button>
        ) : (
          <>
            <button
              className="secondary"
              onClick={() => void onClose()}
              disabled={busy}
            >
              {job?.status === "installed" && !photos.length ? "Cerrar ficha" : "Cancelar"}
            </button>
            {job && job.status !== "installed" && (
              <button
                className="secondary"
                type="submit"
                form="job-form"
                disabled={busy || !online || !!photos.length}
              >
                Guardar cambios
              </button>
            )}
            <button
              className="primary"
              disabled={busy || !online || (job?.status === "installed" && !photos.length)}
              onClick={() => void save(next || undefined)}
            >
              {busy ? (
                <>
                  <LoaderCircle size={18} className="spin" />
                  Guardando…
                </>
              ) : (
                <>
                  {job?.status === "installed" ? "Guardar fotos" : job
                    ? stages.find((item: { id: Status }) => item.id === job.status)?.action
                    : device ? "Guardar local y unidades" : values.width && values.length ? "Guardar medición" : "Guardar para medir después"}
                  {next === "installed" ? (
                    <Check size={18} />
                  ) : (
                    <ArrowRight size={18} />
                  )}
                </>
              )}
            </button>
          </>
        )}
      </div>
    </dialog>
  );
}

function JobHistory({ job, demo, person }: { job: Job; demo: boolean; person: (id: string) => string }) {
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    async function load() {
      try {
        let history: JobEvent[];
        if (demo) history = demoEvents(job.id);
        else {
          const result = await supabase!.from("job_events").select("*").eq("job_id", job.id).order("created_at", { ascending: false });
          if (result.error) throw result.error;
          history = result.data as JobEvent[];
        }
        if (live) setEvents(history);
        const paths = [...new Set(history.flatMap((event) => snapshotPhotoPaths(event.snapshot)))];
        const signed = await Promise.all(paths.map(async (path) => {
          if (demo) return [path, path] as const;
          const result = await supabase!.storage.from("job-photos").createSignedUrl(path, 3600);
          if (result.error) throw result.error;
          return [path, result.data.signedUrl] as const;
        }));
        if (live) { setEvents(history); setUrls(Object.fromEntries(signed)); setError(""); }
      } catch (historyError) { if (live) setError(errorMessage(historyError)); }
    }
    void load();
    const timer = window.setInterval(() => void load(), 120000);
    return () => { live = false; clearInterval(timer); };
  }, [job.id, demo]);
  if (!events.length && !error) return null;
  return <details className="job-history">
    <summary>Historial de revisiones y fotos anteriores {events.length > 0 && `(${events.length})`}</summary>
    {error && <p className="form-error">No se pudo cargar el historial: {error}</p>}
    {events.map((event) => <article className="history-event" key={event.id}>
      <strong>{event.event_type === "review_approved" ? "Colocación revisada" : `Corrección ${event.revision_no}`}</strong>
      <small>{person(event.actor_id)} · {dateTime(event.created_at)}</small>
      {event.notes && <p>{event.notes}</p>}
      {event.snapshot.width_cm != null && event.snapshot.length_cm != null && <p>Medidas anteriores: {format(event.snapshot.width_cm)} × {format(event.snapshot.length_cm)} cm</p>}
      {event.snapshot.installed_at && <p>Colocación anterior: {dateTime(event.snapshot.installed_at)}</p>}
      <div className="photo-grid saved-photo-grid">{snapshotPhotoPaths(event.snapshot).map((path, index) => urls[path] && <a href={urls[path]} key={path} target="_blank" rel="noreferrer"><img src={urls[path]} alt={`Foto anterior de ${job.store_name}, ${index + 1}`} /><small>Abrir foto anterior {index + 1}</small></a>)}</div>
    </article>)}
  </details>;
}
function snapshotPhotoPaths(snapshot: Partial<Job>) {
  return jobPhotoPaths({ photo_path: snapshot.photo_path || null, photo_paths: snapshot.photo_paths });
}

async function shrinkDemoPhoto(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        const scale = Math.min(1, 1000 / Math.max(image.width, image.height));
        canvas.width = image.width * scale;
        canvas.height = image.height * scale;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("No se pudo preparar la foto.");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      } catch (error) {
        reject(error);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Usa una foto JPG o PNG para la vista de ejemplo."));
    };
    image.src = url;
  });
}
