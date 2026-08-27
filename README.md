# Hourglass Panel

Panel gratuito estilo Hourglass: cuadrante de asignaciones en PDF, calendario con recordatorios y proyectos de reunión — todo guardado en tu Google Drive (no hay servidor ni base de datos propia).

## Cómo funciona el almacenamiento

Al iniciar sesión con Google, la app crea (o reutiliza) una carpeta llamada **"Hourglass Panel"** en tu Google Drive y guarda ahí:
- `cuadrante-actual.pdf` — el último PDF subido
- `eventos.json` — los eventos del calendario
- `proyectos.json` — los proyectos de reunión

Se usa el scope `drive.file`, el más restringido posible: la app **solo** puede ver y modificar los archivos que ella misma crea, nunca el resto de tu Drive.

## Puesta en marcha (una sola vez)

1. **Google Cloud Console** → crea un proyecto → *APIs & Services* → *Library* → activa **Google Drive API**.
2. *APIs & Services* → *OAuth consent screen* → tipo **External**, rellena lo básico y añade tu correo como *test user* (así no necesitas pasar la verificación de Google mientras lo uses tú/tu congregación en modo prueba).
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
