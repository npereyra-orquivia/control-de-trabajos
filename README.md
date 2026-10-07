# Control de trabajos

Aplicación web para móvil para coordinar la medida, el corte y la colocación de felpudos, local por local. Usa React, TypeScript y Vite; Supabase guarda las cuentas, los trabajos y las fotos privadas; GitHub Pages sirve la aplicación.

- **URL de la aplicación:** [Control de trabajos](https://npereyra-orquivia.github.io/control-de-trabajos/).
- **Código:** [Repositorio en GitHub](https://github.com/npereyra-orquivia/control-de-trabajos).
- **Proyecto Supabase:** [Orquivia — panel de administración](https://supabase.com/dashboard/project/umpbktnavrxicttqwffs). URL del servicio: `https://umpbktnavrxicttqwffs.supabase.co`.

El proyecto Supabase ya está configurado con el esquema y las fotos privadas. El registro público está cerrado y hay **cinco plazas de usuarios activos**. Las cuentas de las personas siguen pendientes porque aún no se han definido sus correos: deben crearse desde el panel de Supabase cuando estén disponibles.

## Uso diario

1. Inicia sesión con tu correo y contraseña.
2. Crea un trabajo para el local y guarda ancho y largo en centímetros.
3. La persona que corta abre el trabajo y actualiza su estado.
4. Al colocar el felpudo, adjunta la foto del trabajo terminado y márcalo como colocado.

Los estados son **Medido → En corte → Cortado → Colocado**. Se puede buscar por local y filtrar por estado.

La lista consulta los datos compartidos cada **120 segundos** y también se puede actualizar a mano. La sincronización mantiene las ediciones abiertas. Para editar un trabajo se pide un bloqueo a Supabase: solo una persona puede mantenerlo a la vez. El bloqueo dura **180 segundos**, se renueva cada **45 segundos** mientras se edita y se libera al terminar. Si la conexión se corta o se cierra el navegador, caduca por sí solo. Cada guardado comprueba además la versión del trabajo para impedir que una edición antigua sobrescriba cambios nuevos.

## Preparar Supabase

El proyecto **Control de trabajos**, de la organización **Orquivia**, ya tiene instalado el esquema. Para ese proyecto queda pendiente el alta de las cinco personas del paso 4. Los demás pasos permiten preparar otro proyecto desde cero.

1. Crea o elige el proyecto Supabase que se usará para esta aplicación.
2. Abre **SQL Editor**, copia todo el archivo [`supabase/schema.sql`](supabase/schema.sql) y ejecútalo. El archivo crea las tablas, las funciones de edición, los permisos y el bucket privado de fotos.
3. En **Authentication**, desactiva el registro de nuevos usuarios (**Allow new users to sign up**). El acceso está reservado al equipo.
4. En **Authentication → Users → Add user → Create new user**, crea las cuentas de las cinco personas con correo y contraseña. Marca la opción para confirmar automáticamente el correo. Aún no se han definido esos correos; no hay cuentas ni contraseñas de ejemplo.
5. Obtén la **Project URL** y la clave **publishable** o la clave antigua **anon** desde la configuración API del proyecto.

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
5. Abre la URL que devuelve la tarea de publicación. Si utilizas invitaciones o recuperación de contraseña, configura esa URL como **Site URL** y como URL de redirección permitida en Supabase.

El flujo comprueba la configuración, ejecuta las pruebas, compila la aplicación y publica `dist`. Si falta una variable, comprueba el código y muestra un aviso, pero no publica. Vite utiliza rutas relativas (`base: './'`), por lo que funciona también en una dirección como `https://usuario.github.io/control-de-trabajos/`.

Las pruebas de base de datos ejecutan 56 comprobaciones en PGlite con Auth y Storage simulados. Cubren permisos, cinco usuarios, bloqueos, caducidad, versiones, fases y fotos. La conexión HTTP, las cargas reales de Storage y la concurrencia entre dispositivos deben verificarse también con el proyecto de Supabase conectado.

## Añadir al inicio del móvil

- **iPhone:** abre la web en Safari, pulsa **Compartir → Añadir a pantalla de inicio**.
- **Android:** abre la web en Chrome y utiliza **Añadir a pantalla de inicio** o **Instalar aplicación**, si el navegador ofrece esa opción.

La aplicación necesita conexión para sincronizar y guardar. Incluye un manifiesto para abrirse como aplicación desde el inicio del móvil; no utiliza un service worker que mantenga copias locales de trabajos o fotos.
