# Configuración de Supabase

La aplicación usa un proyecto de Supabase dedicado, hasta cinco trabajadores activos y un único equipo que comparte los trabajos. Las medidas se guardan en **centímetros**, con hasta dos decimales.

## Instalación

1. Abre el proyecto de Supabase y entra en **SQL Editor**.
2. Copia y ejecuta todo el contenido de [`schema.sql`](schema.sql). Crea tablas, reglas de acceso, el bucket privado `job-photos` y la suscripción Realtime. Se puede ejecutar otra vez sin borrar los trabajos. Si ya existen más de cinco cuentas sin perfil, el proceso se cancela: utiliza un proyecto dedicado.
3. En **Authentication → Sign In / Providers**, desactiva **Allow new users to sign up** y **Allow anonymous sign-ins**. Mantén habilitado el proveedor de correo y contraseña. No habilites proveedores sociales para este equipo.
4. En **Authentication → URL Configuration**, configura la URL definitiva de GitHub Pages como **Site URL** y añádela también a **Redirect URLs**, incluyendo la carpeta del repositorio y la barra final, por ejemplo `https://TU_USUARIO.github.io/TU_REPOSITORIO/`. Para desarrollo puedes añadir la URL local exacta que use la aplicación.
5. Configura el frontend con la URL del proyecto y su clave **publishable** o **anon**. La aplicación no necesita ni debe publicar claves **secret**, **service_role** o la contraseña de la base de datos. Las reglas RLS son las que protegen los datos cuando se usa la clave pública.

## Dar de alta los cinco usuarios

En **Authentication → Users → Add user → Create new user**, añade cada correo y contraseña; marca el correo como confirmado si la interfaz ofrece esa opción. No hace falta habilitar las altas públicas para crear usuarios desde el panel. El primer usuario recibe `role = 'admin'`; los siguientes, `role = 'member'`. El trigger crea los perfiles y rechaza una sexta cuenta activa, también si dos altas llegan a la vez. El rol y el estado activo no se toman de metadatos editables por el usuario.

Los usuarios entran con correo y contraseña. Para personalizar los nombres, usa **Table Editor → profiles** o ejecuta, sustituyendo el correo de ejemplo:

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
| `store_name`, `address` | Tienda y dirección. |
| `width_cm`, `length_cm`, `quantity` | Medidas positivas en cm y cantidad, por defecto 1. |
| `material`, `notes` | Detalles opcionales, guardados como texto vacío si no hay valor. |
| `status` | `measured`, `cutting`, `cut`, `installed`. |
| `photo_path` | Ruta de la foto en el bucket privado; no se guarda una URL temporal. |
| `version` | Versión que aumenta al guardar; evita sobrescribir datos antiguos. |
| `measured_by`, `cutting_by`, `cut_by`, `installed_by` | Trabajador que registró la medida actual y cada paso, sin atribuirlos al creador por defecto. |
| `created_by`, `updated_by`, fechas | Auditoría que fija la base de datos. |

Todos los miembros activos pueden crear, consultar y modificar trabajos. Los borrados se gestionan desde el SQL Editor, para que una eliminación directa desde el navegador no invalide la edición de otro trabajador. El flujo es `measured` → `cutting` → `cut` → `installed`; no permite saltarse pasos. Para colocar hay que partir de `cut` y subir una foto. Un trabajo colocado no vuelve a una fase anterior. Se pueden corregir las medidas y empezar el corte en el mismo guardado, desde `measured` a `cutting`. Para cambiar medidas, material o cantidad después de empezar el corte, primero devuelve el trabajo a `measured`; así se invalidan las fechas y autores de los pasos siguientes.

Al modificar medidas, material o cantidad mientras el trabajo está medido, se actualizan `measured_at` y `measured_by`. Cada cambio de fase registra su fecha y su autor. El cliente no puede escribir estos datos de auditoría. Si el esquema se actualiza sobre trabajos antiguos que no tenían autores por etapa, esos autores quedan como `null`, sin inventar su identidad.

La aplicación refresca los datos cada **120 segundos**. Para editar o cambiar el estado debe adquirir un bloqueo mediante `acquire_job_lock(p_job_id, p_token)`, con un token UUID nuevo para esa edición. La función devuelve `true` si lo obtiene y `false` si otra edición lo tiene. El bloqueo dura **180 segundos** y debe renovarse con el mismo token cada **45 segundos**, también mientras se sube una foto. Al salir, llama a `release_job_lock(p_job_id, p_token)`; si se cierra el móvil, la concesión caduca automáticamente.

Los cambios se guardan únicamente con `update_job(p_job_id, p_token, p_expected_version, p_patch)`. La función comprueba la cuenta activa, la propiedad y vigencia del bloqueo y la versión antes de aplicar los campos permitidos. Devuelve el trabajo actualizado y su nueva `version`. La API de actualización o borrado directo a `jobs` y las modificaciones directas de `job_locks` no tienen permiso para el navegador. Un fallo de bloqueo (`55P03`) o de versión (`40001`) exige recuperar los datos; no reintentes a ciegas con valores antiguos.

Para mostrar quién está editando, consulta `job_locks` seleccionando expresamente `job_id,user_id,expires_at`. El token está oculto para el navegador; `select('*')` en esta tabla se rechaza. Relaciona `user_id` con los nombres de `profiles` y descarta los bloqueos cuya fecha ya haya caducado.

Sube cada foto con un nombre nuevo y `upsert: false`, de esta forma:

```js
const path = `${job.id}/${crypto.randomUUID()}.jpg`
const { error: uploadError } = await supabase.storage
  .from('job-photos')
  .upload(path, photoFile, { contentType: 'image/jpeg', upsert: false })
if (uploadError) throw uploadError

const { data: savedJob, error: saveError } = await supabase.rpc('update_job', {
  p_job_id: job.id,
  p_token: editingToken,
  p_expected_version: job.version,
  p_patch: { status: 'installed', photo_path: path },
})
if (saveError) {
  // Esta foto todavía no está referenciada y puede limpiarse.
  await supabase.storage.from('job-photos').remove([path])
  throw saveError
}
```

La extensión y el `contentType` deben corresponder al archivo real: JPEG, PNG, WebP, HEIC o HEIF. El límite del bucket es **10 MB** por foto. La subida exige un bloqueo vigente del trabajo a nombre del usuario. El servidor verifica que el objeto existe antes de aceptar la ruta y obliga a adjuntar foto para `installed`. Las políticas no permiten sobrescribir fotos ni borrar un objeto mientras un trabajo lo referencia; el borrado y el guardado se serializan para evitar una foto perdida por concurrencia. Para sustituir una foto, primero sube otra con nombre nuevo y actualiza la ruta del trabajo mediante la misma RPC.

Para verla, usa `createSignedUrl(photo_path, 300)` al abrir el trabajo; esa URL dura cinco minutos. No uses `getPublicUrl`, porque el bucket es privado. Evita guardar URLs firmadas en la tabla o en cachés persistentes.

## Comprobación

- Sin iniciar sesión: no se leen perfiles, trabajos ni fotografías.
- Usuario activo: puede registrar medidas, marcar cortado y colocar con una foto válida; puede ver la foto desde otro móvil del equipo.
- Usuario desactivado: no puede acceder a trabajos ni fotos.
- Sexta alta activa: se rechaza; desactivar un perfil libera una plaza.
- Dos usuarios abren el mismo trabajo: solo uno obtiene el bloqueo. Dos pestañas de la misma cuenta con tokens diferentes tampoco pueden editarlo a la vez.
- Bloqueo caducado, token ajeno, versión antigua o actualización/borrado directo por REST: se rechaza.
- Cambiar medidas mientras el trabajo sigue cortado o colocado: se rechaza.
- Colocado sin foto, o con una ruta inexistente: se rechaza.
- Borrar o sobrescribir una foto referenciada desde el navegador: se rechaza.

Documentación oficial: [perfiles y triggers de Auth](https://supabase.com/docs/guides/auth/managing-user-data), [configuración de altas](https://supabase.com/docs/guides/auth/general-configuration), [URLs de redirección](https://supabase.com/docs/guides/auth/redirect-urls), [políticas de Storage](https://supabase.com/docs/guides/storage/security/access-control) y [buckets privados](https://supabase.com/docs/guides/storage/buckets/fundamentals).
