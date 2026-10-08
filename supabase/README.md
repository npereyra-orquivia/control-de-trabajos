# Configuración de Supabase

La aplicación usa un proyecto de Supabase dedicado, hasta cinco trabajadores activos y un único equipo que comparte los trabajos. **El registro permite entrar inmediatamente, sin confirmar el correo.** El ancho y el largo se guardan en **centímetros**, con hasta dos decimales; el espesor se guarda en **milímetros**, como `17`, `20` o `null` cuando se elige **No sé**.

## Instalación

Para actualizar el proyecto ya instalado con el nuevo espesor, ejecuta solo [`migrations/20261007_add_thickness.sql`](migrations/20261007_add_thickness.sql). Conserva los datos y los permisos existentes; se puede volver a ejecutar.

Para actualizar el flujo a **Medido → Cortado → Colocado** y garantizar una tarea por felpudo, ejecuta [`migrations/20261008_three_stages_one_mat.sql`](migrations/20261008_three_stages_one_mat.sql) después de las migraciones de espesor y responsable. Es una transacción reejecutable: elimina la fase intermedia, separa cantidades mayores de uno en tareas individuales y conserva medidas, notas, responsables y permisos. Si hubiera una tarea ya colocada con varias unidades, la migración se cancela para que se adjunte primero una foto individual a cada felpudo.

Para admitir **varias fotos por trabajo**, ejecuta después [`migrations/20261008_multiple_photos.sql`](migrations/20261008_multiple_photos.sql). Conserva las fotos existentes y las convierte en una lista, sin cambiar estados, fechas, autores, versiones ni bloqueos. Se puede volver a ejecutar y sigue exigiendo **al menos una foto** para colocar. Ejecuta esta migración después de las anteriores, porque actualiza las funciones de guardado y validación.

Para separar **Felpudos / Deshumidificadores** y habilitar **revisiones y correcciones**, ejecuta al final [`migrations/20261009_job_types_and_reviews.sql`](migrations/20261009_job_types_and_reviews.sql). Es reejecutable y conserva trabajos, fotos, fechas, versiones y bloqueos. Los registros existentes reciben `job_kind = 'mat'` y revisión pendiente. No convierte nombres ni deduce cantidades: la clasificación de registros existentes debe hacerse después de comprobar sus datos. Crea `job_events`, compartido por los mismos cinco usuarios activos.

1. Abre el proyecto de Supabase y entra en **SQL Editor**.
2. Copia y ejecuta todo el contenido de [`schema.sql`](schema.sql). Crea tablas, reglas de acceso, el bucket privado `job-photos` y la suscripción Realtime. Se puede ejecutar otra vez sin borrar los trabajos. Si ya existen más de cinco cuentas sin perfil, el proceso se cancela: utiliza un proyecto dedicado.
3. En **Authentication → Sign In / Providers**, habilita **Allow new users to sign up** y el proveedor de correo y contraseña. Mantén desactivado **Allow anonymous sign-ins**. El formulario permite que los trabajadores creen sus propias cuentas.
4. En la configuración del proveedor de correo, desactiva **Confirm email**. Supabase crea la cuenta y devuelve una sesión en el mismo registro. No hace falta SMTP ni enviar un mensaje para acceder a la aplicación.
5. En **Authentication → URL Configuration**, configura la URL definitiva de GitHub Pages como **Site URL** y añádela también a **Redirect URLs**, incluyendo la carpeta del repositorio y la barra final, por ejemplo `https://TU_USUARIO.github.io/TU_REPOSITORIO/`. Para desarrollo puedes añadir la URL local exacta que use la aplicación. Estas URLs sirven para confirmaciones, invitaciones o recuperación por correo si se habilitan posteriormente.
6. Configura el frontend con la URL del proyecto y su clave **publishable** o **anon**. La aplicación no necesita ni debe publicar claves **secret**, **service_role** o la contraseña de la base de datos. Las reglas RLS son las que protegen los datos cuando se usa la clave pública.

## Registro de los cinco usuarios

Cada persona pulsa **Registrarme** en la aplicación, introduce su nombre y correo, elige una contraseña de al menos ocho caracteres, la repite y pulsa **Crear cuenta**. **Entra directamente, sin abrir ningún correo ni repetir el inicio de sesión.** El formulario envía el nombre como `display_name`; el trigger crea su perfil. El primer usuario recibe `role = 'admin'`; los siguientes, `role = 'member'`. El rol y el estado activo los fija el servidor, sin tomarlos de metadatos editables por el usuario.

La base de datos rechaza una sexta cuenta activa, también si dos altas llegan a la vez. El perfil ocupa una plaza desde el registro. Los miembros activos del único equipo comparten todos los trabajos. Para revisar las cuentas, usa **Authentication → Users**.

### Alternativa opcional: confirmación por correo

El proyecto utiliza **Confirm email desactivado**. El alta devuelve una sesión y la aplicación entra inmediatamente; no envía un correo de confirmación. El límite de cinco plazas y los permisos de los trabajos se mantienen.

Con **Confirm email** habilitado, la persona debe abrir el enlace de confirmación recibido antes de iniciar sesión. El formulario muestra un aviso para revisar el correo y la carpeta de spam; el enlace vuelve a la aplicación mediante `emailRedirectTo`. Si el correo ya tiene cuenta, debe utilizar **Entrar**.

Para enviar confirmaciones a correos de los trabajadores, configura un servidor SMTP propio en **Authentication → Emails → SMTP Settings**. El servicio predeterminado de Supabase solo envía a correos que pertenecen al equipo de la organización de Supabase y tiene un límite de dos mensajes por hora; no basta para dar de alta a cinco trabajadores con otros correos. Véase la [documentación de SMTP](https://supabase.com/docs/guides/auth/auth-smtp).

Esta alternativa requiere habilitar **Confirm email** y SMTP expresamente. Las cuentas pendientes de confirmar también ocupan una plaza, porque el perfil se crea durante el registro. La aplicación admite ambos flujos según la configuración del proyecto.

Los usuarios entran después con correo y contraseña. El nombre se guarda durante el registro; para corregirlo desde administración, usa **Table Editor → profiles** o ejecuta, sustituyendo el correo de ejemplo:

```sql
update public.profiles
set display_name = 'Nicole'
where id = (select id from auth.users where email = 'nicole@ejemplo.com');
```

Para retirar acceso sin perder el historial, desactiva el perfil desde SQL Editor. Desde ese momento la cuenta deja de poder leer, modificar trabajos o descargar nuevas fotos, aunque tuviera una sesión abierta. Una URL firmada que ya se hubiera emitido caduca al terminar su plazo.

```sql
update public.profiles
set active = false
where id = (select id from auth.users where email = 'persona@ejemplo.com');
```

Esto libera una de las cinco plazas para otra cuenta. Reactivar un perfil también exige que haya una plaza libre. `member_slot` es interno y lo administra el trigger. Para cambiar al administrador, actualiza `role` desde el SQL Editor; nunca desde el navegador.

## Trabajos y fotos

| Campo | Uso |
| --- | --- |
| `store_name`, `address` | Tienda y dirección antigua. La dirección se conserva en la base de datos y se oculta en la aplicación. |
| `job_kind` | `mat` (Felpudos) o `dehumidifier` (Deshumidificadores). Se elige al crear y no se modifica en la RPC normal. |
| `width_cm`, `length_cm` | Medidas positivas en cm, con hasta dos decimales. Ambas `null` para aparatos y felpudos pendientes de medir; no se admite una sola medida. |
| `thickness_mm` | Espesor: `17` o `20` mm; `null` significa **No sé**. No se guarda como cero. |
| `quantity` | Felpudos: fijo en `1`, cada tarea es una pieza. Aparatos: entero positivo de unidades que necesita el local. |
| `material` | Las nuevas mediciones ofrecen **Coco**, **Metálico** y **No hay**. El campo de texto conserva los materiales de trabajos anteriores. |
| `notes` | Detalles opcionales, guardados como texto vacío si no hay valor. |
| `status` | Felpudos: `pending_measurement` (Por medir), `measured` (Medido), `cut` (Cortado), `installed` (Colocado); un recorte usa `pending_adjustment` (Por ajustar). Aparatos: `pending_installation` (Por colocar) → `installed`. |
| `review_status`, `rework_kind` | Revisión: `pending`, `approved` o `needs_adjustment`; corrección: `trim`, `add`, `replace`, o `null` antes de una corrección. |
| `revision_no`, `review_notes`, `reviewed_at`, `reviewed_by` | Ciclo de corrección desde `0`, indicaciones y auditoría de revisión. Solo los cambia la RPC de revisión. |
| `photo_paths` | Lista ordenada de rutas de todas las fotos en el bucket privado; no se guardan URLs temporales. |
| `photo_path` | Primera ruta de `photo_paths`, mantenida para clientes antiguos. |
| `version` | Versión que aumenta al guardar; evita sobrescribir datos antiguos. |
| `measured_by`, `cut_by`, `installed_by` | Trabajador que registró la medida actual y cada paso, sin atribuirlos al creador por defecto. `cutting_by` y `cutting_at` se mantienen como columnas antiguas y no se usan en el flujo nuevo. |
| `created_by`, `updated_by`, fechas | Auditoría que fija la base de datos. |

Todos los miembros activos pueden crear, consultar y modificar trabajos. Los borrados se gestionan desde el SQL Editor, para que una eliminación directa desde el navegador no invalide la edición de otro trabajador. El flujo normal de felpudos es `measured` → `cut` → `installed`; si falta medir, se crea con `pending_measurement` y ambas medidas `null`. Para pasar a medido se exigen ambas medidas positivas. Los aparatos se crean con `job_kind: 'dehumidifier'`, `status: 'pending_installation'`, cantidad positiva, medidas y espesor `null`, material vacío. Pasan directamente a `installed`; no tienen corte ni fecha/autor de medición. Su cantidad puede corregirse mientras estén pendientes.

Toda colocación exige al menos una foto subida; las adicionales son opcionales. Si falta, el servidor devuelve **«Te falta hacer la foto del trabajo colocado»**. Un colocado solo se reabre mediante su revisión. Puede recibir fotos adicionales con el mismo bloqueo y versión, sin alterar fecha ni autor de colocación. Se pueden corregir medidas y espesor y marcar cortado en el mismo guardado desde `measured` a `cut`. Para cambiar medidas, espesor o material después de cortar, primero devuelve el felpudo a `measured`; se invalidan las fechas y autores de los pasos siguientes.

## Revisar y corregir felpudos

`review_job(p_job_id, p_token, p_expected_version, p_action, p_notes)` devuelve el trabajo actualizado. Exige usuario activo, bloqueo vigente, versión actual y un felpudo colocado. Todos los integrantes activos pueden inspeccionar.

| Acción | Resultado |
| --- | --- |
| `approve` | Revisión aprobada. Conserva fase, medidas, fotos y fecha/autor de colocación. Nota opcional. |
| `trim` | Abre **Por ajustar**, conserva medidas y auditoría de medición. Al terminar pasa directamente a colocado con foto nueva. |
| `add` | Abre **Por medir** para medir la pieza que falta, cortarla y colocarla. No deduce las medidas de la pieza anterior. |
| `replace` | Abre **Por medir** para volver a medir, cortar y sustituir el felpudo completo. |

Las correcciones requieren instrucciones (máximo 3000 caracteres), incrementan `revision_no` y dejan revisión **Requiere corrección**. Conservan material, espesor, responsable y notas generales. `add` y `replace` borran medidas y auditoría de medición actuales; las anteriores siguen en el historial. Toda reapertura borra las fotos actuales y fechas/autores de corte y colocación. El recorte conserva la medición original. Al colocar una corrección se registra la nueva fecha/autor y vuelve a revisión pendiente.

Antes de cambiar nada, `job_events` guarda en `snapshot` una copia completa del trabajo anterior, incluidas todas sus fotos y auditoría. `review_approved` registra la aprobación; `rework_started`, la apertura de un ciclo. Al reabrir, el evento tiene el número del ciclo nuevo y `snapshot.revision_no` el anterior. Se consulta con `select('*').eq('job_id', job.id).order('created_at', { ascending: false })`. Los activos pueden leer; los clientes no pueden insertar, modificar ni borrar eventos, ni escribir campos de revisión por `update_job`. El permiso interno de reapertura está en una tabla privada limitado a transacción, autor y versión; no usa una variable que el navegador pueda falsificar.

Las fotos del historial quedan visibles y protegidas contra borrado. No se pueden adjuntar de nuevo como prueba de una corrección: hay que subir fotos con rutas nuevas. Para mostrarlas se firman las rutas de `snapshot.photo_paths`, igual que las actuales. Añadir fotos actuales tras colocar conserva el historial existente.

Al modificar medidas, espesor o material mientras el trabajo está medido, se actualizan `measured_at` y `measured_by`. Cada cambio de fase registra su fecha y su autor. El cliente no puede escribir estos datos de auditoría. Si el esquema se actualiza sobre trabajos antiguos que no tenían autores por etapa, esos autores quedan como `null`, sin inventar su identidad. El nuevo `thickness_mm` también queda como `null` en trabajos antiguos cuyo espesor no estaba registrado; no se deduce del texto del material.

La aplicación refresca los datos cada **120 segundos**. Para editar o cambiar el estado debe adquirir un bloqueo mediante `acquire_job_lock(p_job_id, p_token)`, con un token UUID nuevo para esa edición. La función devuelve `true` si lo obtiene y `false` si otra edición lo tiene. El bloqueo dura **180 segundos** y debe renovarse con el mismo token cada **45 segundos**, también mientras se sube una foto. Al salir, llama a `release_job_lock(p_job_id, p_token)`; si se cierra el móvil, la concesión caduca automáticamente.

Los cambios se guardan únicamente con `update_job(p_job_id, p_token, p_expected_version, p_patch)`. La función comprueba la cuenta activa, la propiedad y vigencia del bloqueo y la versión antes de aplicar los campos permitidos. Devuelve el trabajo actualizado y su nueva `version`. La API de actualización o borrado directo a `jobs` y las modificaciones directas de `job_locks` no tienen permiso para el navegador. Un fallo de bloqueo (`55P03`) o de versión (`40001`) exige recuperar los datos; no reintentes a ciegas con valores antiguos.

Para mostrar quién está editando, consulta `job_locks` seleccionando expresamente `job_id,user_id,expires_at`. El token está oculto para el navegador; `select('*')` en esta tabla se rechaza. Relaciona `user_id` con los nombres de `profiles` y descarta los bloqueos cuya fecha ya haya caducado.

Sube cada foto con un nombre nuevo y `upsert: false`. Después envía la lista completa de rutas, conservando las que ya tenía el trabajo. Ejemplo para fotos JPEG:

```js
const uploaded = []
const existing = job.photo_paths?.length
  ? job.photo_paths
  : job.photo_path ? [job.photo_path] : []
try {
  for (const photoFile of photos) {
    const path = `${job.id}/${crypto.randomUUID()}.jpg`
    const { error } = await supabase.storage
      .from('job-photos')
      .upload(path, photoFile, { contentType: 'image/jpeg', upsert: false })
    if (error) throw error
    uploaded.push(path)
  }
  const { data: savedJob, error } = await supabase.rpc('update_job', {
    p_job_id: job.id,
    p_token: editingToken,
    p_expected_version: job.version,
    p_patch: { status: 'installed', photo_paths: [...existing, ...uploaded] },
  })
  if (error) throw error
} catch (error) {
  // Solo los objetos nuevos que no hayan quedado adjuntos se pueden limpiar.
  if (uploaded.length) await supabase.storage.from('job-photos').remove(uploaded)
  throw error
}
```

La extensión y el `contentType` deben corresponder al archivo real: JPEG, PNG, WebP, HEIC o HEIF. El límite del bucket es **10 MB por foto**. La subida exige un bloqueo vigente del trabajo a nombre del usuario. El servidor verifica que **todos** los objetos existen, pertenecen a la carpeta del trabajo y tienen rutas distintas antes de guardar. Las políticas no permiten sobrescribir fotos ni borrar ningún objeto mientras aparezca en la lista del trabajo o en una copia histórica; el borrado, la revisión y el guardado se serializan para evitar una foto perdida por concurrencia. El guardado de la lista es atómico: una ruta inválida impide todo el cambio, incluida la colocación.

La RPC sigue aceptando `photo_path` de clientes antiguos: cambia la primera foto y conserva las adicionales. Las nuevas pantallas envían `photo_paths`, que representa la lista completa, y conservan las fotos ya guardadas al añadir más.

Para verlas, usa `createSignedUrl(path, 300)` por cada ruta o `createSignedUrls(photo_paths, 300)` al abrir el trabajo; esas URLs duran cinco minutos. No uses `getPublicUrl`, porque el bucket es privado. Evita guardar URLs firmadas en la tabla o en cachés persistentes.

## Comprobación

- Sin iniciar sesión: no se leen perfiles, trabajos ni fotografías.
- Registro: devuelve una sesión y abre el equipo inmediatamente con **Confirm email** desactivado.
- Usuario activo: puede registrar ancho y largo en cm, espesor 17/20 mm o desconocido, marcar cortado y colocar con una foto válida; puede ver la foto desde otro móvil del equipo.
- Usuario desactivado: no puede acceder a trabajos ni fotos.
- Sexta alta activa: se rechaza; desactivar un perfil libera una plaza.
- Dos usuarios abren el mismo trabajo: solo uno obtiene el bloqueo. Dos pestañas de la misma cuenta con tokens diferentes tampoco pueden editarlo a la vez.
- Bloqueo caducado, token ajeno, versión antigua o actualización/borrado directo por REST: se rechaza.
- Espesores distintos de 17/20 mm y del valor desconocido `null`: se rechazan.
- La fase retirada `cutting`, cantidades de felpudo distintas de `1` y cantidades de aparatos no positivas: se rechazan.
- Aparatos: colocación directa con foto; no admiten fases de medición/corte ni medidas, espesor o material de felpudo.
- Felpudos pendientes de medir: ambos lados vacíos; pasar a medido exige ambos positivos.
- Cambiar medidas o espesor mientras el trabajo sigue cortado o colocado: se rechaza.
- Colocado sin fotos, o con cualquier ruta inexistente, repetida o de otro trabajo: se rechaza sin guardar parcialmente.
- Añadir varias fotos a un trabajo colocado: conserva las anteriores y la fecha y el autor originales de colocación.
- Revisar con bloqueo incorrecto, versión antigua o cuenta inactiva: se rechaza.
- Aprobar conserva fotos, fase y auditoría; archiva una copia previa.
- Recortar reabre **Por ajustar** sin cambiar medidas. Añadir/sustituir reabre **Por medir**. Las correcciones exigen instrucciones y fotos nuevas al colocar.
- Reutilizar la foto de una colocación anterior como prueba de corrección: se rechaza.
- Escribir o borrar historial o campos de revisión desde la API normal: se rechaza.
- Borrar o sobrescribir fotos actuales o históricas desde el navegador: se rechaza.
- Repetir migración y esquema completo: conserva fotos, historial, revisiones, cantidades de aparatos y bloqueos.

Documentación oficial: [perfiles y triggers de Auth](https://supabase.com/docs/guides/auth/managing-user-data), [configuración de altas](https://supabase.com/docs/guides/auth/general-configuration), [URLs de redirección](https://supabase.com/docs/guides/auth/redirect-urls), [políticas de Storage](https://supabase.com/docs/guides/storage/security/access-control) y [buckets privados](https://supabase.com/docs/guides/storage/buckets/fundamentals).
