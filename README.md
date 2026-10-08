# Control de trabajos

Aplicación web para móvil para coordinar la medida, el corte y la colocación de felpudos, local por local. Usa React, TypeScript y Vite; Supabase guarda las cuentas, los trabajos y las fotos privadas; GitHub Pages sirve la aplicación.

- **URL de la aplicación:** [Control de trabajos](https://npereyra-orquivia.github.io/control-de-trabajos/).
- **Código:** [Repositorio en GitHub](https://github.com/npereyra-orquivia/control-de-trabajos).
- **Proyecto Supabase:** [Orquivia — panel de administración](https://supabase.com/dashboard/project/umpbktnavrxicttqwffs). URL del servicio: `https://umpbktnavrxicttqwffs.supabase.co`.

El proyecto Supabase está configurado para entrar inmediatamente después del registro, sin correo de confirmación. Cada persona puede darse de alta desde **Registrarme**, con nombre, correo y contraseña de al menos ocho caracteres. Hay **cinco plazas de usuarios activos**. La primera cuenta recibe el rol de administrador y las siguientes el de miembro.

## Uso diario

1. Inicia sesión con el **usuario o correo y contraseña** de tu cuenta. Las cuentas preparadas para el equipo admiten su nombre de usuario; los correos existentes siguen funcionando. Si aún quedan plazas y necesitas una nueva cuenta, pulsa **Registrarme**. Las contraseñas y el listado privado de accesos no se publican en el repositorio.
2. Crea **un trabajo por felpudo** y guarda **ancho y largo en centímetros**. Si un local tiene dos o tres felpudos, cada uno lleva su ficha y sus medidas. Elige el **espesor en milímetros: 20 mm, 17 mm o No sé**, y el material: **Coco, Metálico o No hay**. «No sé» se guarda como espesor desconocido (`null`), nunca como cero. El **responsable** aparece junto al nombre del local y se elige entre los miembros activos. Una nueva medición se asigna inicialmente a quien la crea; las fichas anteriores sin asignación permanecen sin asignar. Se puede cambiar el responsable mientras el trabajo está pendiente, respetando la reserva de edición. La dirección y la cantidad se ocultan; cada ficha representa siempre una pieza.
3. Abre la ficha para revisar los datos. Puedes **Guardar cambios** sin avanzar el estado. Cuando esté cortado, pulsa **Marcar cortado**.
4. Cuando el felpudo esté colocado, añade su foto y pulsa **Marcar colocado**. Si falta la foto, aparece un aviso y el trabajo sigue Cortado.

Los estados son **Medido → Cortado → Colocado**. Se puede buscar por nombre o número de local y combinar filtros por estado, material y espesor. **No sé / notas** incluye espesores desconocidos y valores distintos de 17/20 mm conservados en notas. **Sin especificar** distingue un material pendiente del valor explícito **No hay**. Los materiales adicionales ya registrados también aparecen como opciones. **Limpiar filtros** vuelve a mostrar todos los trabajos.

**Observaciones** muestra los datos pendientes y las indicaciones útiles para el trabajo. Los textos de la importación se resumen para facilitar la lectura; el listado y el chat originales siguen disponibles en **Ver información original del listado y el chat**. Editar las observaciones conserva esa referencia. Las medidas, el material, el espesor y el responsable de la ficha muestran los datos actuales.

La lista consulta los datos compartidos cada **120 segundos** y también se puede actualizar a mano. La sincronización mantiene las ediciones abiertas. Para editar un trabajo se pide un bloqueo a Supabase: solo una persona puede mantenerlo a la vez. El bloqueo dura **180 segundos**, se renueva cada **45 segundos** mientras se edita y se libera al terminar. Si la conexión se corta o se cierra el navegador, caduca por sí solo. Cada guardado comprueba además la versión del trabajo para impedir que una edición antigua sobrescriba cambios nuevos.

## Preparar Supabase

El proyecto **Control de trabajos**, de la organización **Orquivia**, ya tiene instalado el esquema. Estos pasos permiten revisar su configuración o preparar otro proyecto desde cero.

1. Crea o elige el proyecto Supabase que se usará para esta aplicación.
2. Abre **SQL Editor**, copia todo el archivo [`supabase/schema.sql`](supabase/schema.sql) y ejecútalo. El archivo crea las tablas, las funciones de edición, los permisos y el bucket privado de fotos.
3. En **Authentication → Sign In / Providers**, habilita **Allow new users to sign up** y el proveedor de correo y contraseña. Mantén desactivado **Allow anonymous sign-ins**.
4. En la configuración del proveedor de correo, mantén **Confirm email desactivado**. Es el flujo elegido para este proyecto: **Crear cuenta** devuelve una sesión y permite entrar directamente. No requiere SMTP ni enviar un correo de confirmación. La alternativa con confirmación y SMTP está documentada en [`supabase/README.md`](supabase/README.md).
5. En **Authentication → URL Configuration**, configura la URL de GitHub Pages como **Site URL** y añádela a **Redirect URLs**, con la carpeta del repositorio y la barra final. Estas URLs se utilizan si después se habilitan confirmaciones, invitaciones o recuperación por correo.
6. Obtén la **Project URL** y la clave **publishable** o la clave antigua **anon** desde la configuración API del proyecto.

Para actualizar una instalación anterior al flujo de tres estados, ejecuta [`supabase/migrations/20261008_three_stages_one_mat.sql`](supabase/migrations/20261008_three_stages_one_mat.sql) después de las migraciones de espesor y responsable. Conserva los datos y las reglas de edición; garantiza una tarea por felpudo. La configuración y las migraciones se detallan en [`supabase/README.md`](supabase/README.md).

La URL y la clave publicable/anon se incluyen en la aplicación del navegador. La protección de los datos depende de las políticas de Supabase y de la sesión de cada usuario. **No copies una clave `service_role` ni una clave secreta** al proyecto, a `.env` o a GitHub Actions. El esquema aplica políticas de acceso y un límite de cinco cuentas de trabajo.

Las fotos se guardan en un bucket privado y se abren con enlaces temporales para usuarios autenticados. No se publican en GitHub Pages.

## Ejecutar en tu ordenador

Requiere **Node.js 22.12 o posterior**; la publicación utiliza Node.js 24.

```powershell
npm ci
Copy-Item .env.example .env
```

Edita `.env` y completa ambas variables con los datos de Supabase:

```dotenv
VITE_SUPABASE_URL=https://tu-proyecto.supabase.co
VITE_SUPABASE_ANON_KEY=tu-clave-publicable-o-anon
```

```powershell
npm run dev
```

Abre la dirección que muestra Vite. Para probar desde el móvil en la misma red, utiliza la dirección de red que muestra el servidor.

```powershell
npm test
npm run build
npm run preview
```

El archivo `.env` se excluye de Git. Reinicia el servidor después de cambiar las variables. Sin configuración de Supabase, la aplicación puede mostrar una vista previa local para revisar su diseño; esos datos no coordinan al equipo ni crean cuentas reales.

## Publicar en GitHub Pages

1. Sube este proyecto a un repositorio GitHub con rama principal `main`, incluido `package-lock.json`.
2. En **Settings → Secrets and variables → Actions → Variables**, crea estas dos **Repository variables**:
   - `VITE_SUPABASE_URL`: URL del proyecto.
   - `VITE_SUPABASE_ANON_KEY`: clave publicable o anon.
3. En **Settings → Pages → Build and deployment → Source**, selecciona **GitHub Actions**.
4. Sube los cambios a `main` o ejecuta manualmente el flujo **Publicar en GitHub Pages** desde **Actions**.
5. Abre la URL que devuelve la tarea de publicación. Configura esa URL como **Site URL** y como URL de redirección permitida en Supabase para los enlaces de autenticación por correo que puedan utilizarse después.

El flujo comprueba la configuración, ejecuta las pruebas, compila la aplicación y publica `dist`. Si falta una variable, comprueba el código y muestra un aviso, pero no publica. Vite utiliza rutas relativas (`base: './'`), por lo que funciona también en una dirección como `https://usuario.github.io/control-de-trabajos/`.

Las pruebas de base de datos ejecutan el esquema en PGlite con Auth y Storage simulados. Cubren permisos, cinco usuarios, medidas y espesor, bloqueos, caducidad, versiones, fases y fotos. La conexión HTTP, las cargas reales de Storage y la concurrencia entre dispositivos deben verificarse también con el proyecto de Supabase conectado.

## Añadir al inicio del móvil

- **iPhone:** abre la web en Safari, pulsa **Compartir → Añadir a pantalla de inicio**.
- **Android:** abre la web en Chrome y utiliza **Añadir a pantalla de inicio** o **Instalar aplicación**, si el navegador ofrece esa opción.

La aplicación necesita conexión para sincronizar y guardar. Incluye un manifiesto para abrirse como aplicación desde el inicio del móvil; no utiliza un service worker que mantenga copias locales de trabajos o fotos.
