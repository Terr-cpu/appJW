# Agenda JW

Panel gratuito para la congregación: cuadrante de asignaciones en PDF, calendario con recordatorios, tareas, horas de ministerio, proyectos de reunión y un explorador de tus carpetas de Drive — todo guardado en tu Google Drive (no hay servidor ni base de datos propia).

> Para instalarlo como app Android privada (APK) con widgets, mira [`MOBILE.md`](MOBILE.md).

## Cómo funciona el almacenamiento

Al iniciar sesión con Google, la app crea (o reutiliza) una carpeta llamada **"Agenda JW"** en tu Google Drive (renombra automáticamente la antigua "Hourglass Panel" si existe) y guarda ahí todos sus datos:
`cuadrante-<sello>.pdf` + `asignaciones-<sello>.json` (historial de cuadrantes), `cuadrantes.json`,
`historial-asignaciones.json`, `asignaciones-ocultas.json`, `eventos.json`, `proyectos.json`,
`ministerio.json`, `tareas.json`, `explorador-favoritos.json`.

Scopes usados:
- **`.../auth/drive`** — guardar cuadrantes en la carpeta que elijas (p. ej. `JW/Cuadrantes`) y el explorador de archivos.
- **`.../auth/calendar`** — crear un calendario **«Agenda JW»** en tu cuenta y volcar ahí eventos, tareas y asignaciones con **recordatorios**, para que los avisos suenen aunque la app esté cerrada. Se activa con la casilla *«Sincronizar con Google Calendar»* en la pestaña Calendario.

Los datos internos de la app siguen en su carpeta **"Agenda JW"** de Drive; los documentos de cuadrante van a la carpeta que tú elijas.

## Puesta en marcha (una sola vez)

1. **Google Cloud Console** → crea un proyecto → *APIs & Services* → *Library* → activa **Google Drive API** y **Google Calendar API**.
2. *APIs & Services* → *OAuth consent screen* → tipo **External**, rellena lo básico, en *Scopes* añade `.../auth/drive` y `.../auth/calendar`, y añade tu correo como *test user*. En modo prueba con test users funciona sin verificación de Google (aunque salga el aviso «app no verificada» → *Configuración avanzada → continuar*).
3. *APIs & Services* → *Credentials* → **Create credentials → OAuth client ID** → tipo **Web application**.
   - En *Authorized JavaScript origins* añade la URL donde publiques la app, por ejemplo:
     `https://tu-usuario.github.io`
4. Copia el **Client ID** generado y pégalo en `app.js`, en `CONFIG.CLIENT_ID`.
5. Publica los archivos (`index.html`, `style.css`, `app.js`, `manifest.json`, `sw.js`) en GitHub Pages, igual que tus otros proyectos.
6. Abre la URL publicada, pulsa **Entrar con Google** y acepta el permiso.

## Localizar tu nombre en el cuadrante

El campo "Mi nombre" analiza el PDF **en tu propio navegador** (con la librería pdf.js, sin subir el texto a ningún sitio) y construye tarjetas con lo que encuentra: fecha detectada (si la línea o las líneas justo encima incluyen una fecha o día de la semana), página, y el texto de la fila donde apareces, con tu nombre resaltado. Así ves de un vistazo qué tienes asignado sin abrir el PDF; el botón de cada tarjeta salta a la página exacta solo si necesitas más contexto.

Es una detección por heurística de texto (no entiende tablas como tal), así que:
- Funciona bien si el PDF trae el texto en filas razonablemente ordenadas (como los cuadrantes generados digitalmente).
- La fecha puede no detectarse en diseños muy irregulares — en ese caso la tarjeta muestra solo la página.
- No funciona con PDFs escaneados (imagen sin texto seleccionable).

## Notas

- Los recordatorios del calendario se muestran como notificación del navegador **mientras la pestaña está abierta**; para una alarma fiable aunque el móvil esté bloqueado, usa el botón ⇩ de cada evento para descargar un `.ics` y añadirlo al calendario nativo del teléfono.
- El token de sesión dura unos 50 minutos; pasado ese tiempo, un nuevo "Entrar con Google" lo renueva.
- Como es de un único usuario por sesión de Drive, si varias personas van a subir el cuadrante o editar el calendario, cada una necesita su propia cuenta y verá solo lo que ha creado con esta app — si quieres un Drive compartido común, dímelo y lo adaptamos a una carpeta compartida con una cuenta de servicio (como en Montequinto).
