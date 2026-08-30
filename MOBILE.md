# Agenda JW — APK Android privada (Capacitor) con widgets y alertas nativas

La web sigue funcionando igual en GitHub Pages. Esto la empaqueta como **APK que
instalas tú por sideload** (sin Play Store), con:

- **Login de Google nativo** (obligatorio: Google bloquea OAuth dentro de un WebView).
- **Alertas nativas** que suenan con la app cerrada (`@capacitor/local-notifications`).
- **3 widgets** de pantalla de inicio: *Hoy*, *Próxima reunión*, *Horas del mes*.
- (La sincronización con **Google Calendar** ya funciona igual en web y en APK.)

El código JS ya está preparado (detecta si corre en Capacitor). Aquí solo montas el
proyecto Android y pegas 6 archivos Kotlin/XML de la carpeta [`mobile/`](mobile/).

---

## 0. En tu PC (Windows sirve)

| Requisito | Enlace |
|---|---|
| **Node.js 18+** | https://nodejs.org |
| **JDK 17** (Temurin) | https://adoptium.net |
| **Android Studio** (incluye el SDK) | https://developer.android.com/studio → ábrelo una vez y deja que instale *Platform* + *Build-Tools* |

---

## 1. Instalar dependencias y crear el proyecto Android

Desde la carpeta del repo:

```bash
npm install
npm run cap:add
```

`npm run cap:add` copia la web a `www/` (solo los archivos necesarios, deja fuera
`muestras/`) y crea `android/`.

Iconos de la app (usa el PNG grande como fuente):

```bash
npm install -D @capacitor/assets
mkdir resources && copy icon-512.png resources\icon.png
npx capacitor-assets generate --android --iconBackgroundColor "#1C2A3A" --iconBackgroundColorDark "#1C2A3A"
```

---

## 2. Login de Google (Google Cloud Console)  ⚠️ imprescindible

1. *APIs & Services → Credentials → Create credentials → OAuth client ID* → tipo **Android**.
   - *Package name*: `org.agendajw.app`
   - *SHA-1* de tu keystore de depuración:
     ```bash
     keytool -list -v -keystore "%USERPROFILE%\.android\debug.keystore" -alias androiddebugkey -storepass android -keypass android
     ```
     (y repite con el SHA-1 de tu keystore de **release** cuando lo crees en el paso 5).
2. Mantén el cliente **Web** que ya tienes: su Client ID va como `serverClientId` en
   `capacitor.config.json` (ya está puesto).
3. *OAuth consent screen → Scopes*: deben estar `.../auth/drive` y `.../auth/calendar`.
   *Test users*: tu correo.

`app.js` ya detecta Capacitor y usa el plugin nativo `GoogleAuth` en vez de GIS.

---

## 3. Widgets + alertas nativas (pegar 6 archivos)

Copia desde [`mobile/`](mobile/) a `android/app/src/main/`:

| Origen | Destino |
|---|---|
| `mobile/java/WidgetBridge.kt` | `java/org/agendajw/app/WidgetBridge.kt` |
| `mobile/java/Widgets.kt` | `java/org/agendajw/app/Widgets.kt` |
| `mobile/res/layout/widget_common.xml` | `res/layout/widget_common.xml` |
| `mobile/res/xml/hoy_widget_info.xml` | `res/xml/hoy_widget_info.xml` (y **cópialo** como `reunion_widget_info.xml` y `horas_widget_info.xml`) |

Luego:

1. **Registrar el plugin.** En `java/org/agendajw/app/MainActivity.java`, dentro de `onCreate`
   antes de `super.onCreate`, añade:
   ```java
   registerPlugin(WidgetBridge.class);
   ```
2. **Manifest.** Pega los 3 `<receiver>` de `mobile/AndroidManifest-snippet.xml` dentro de
   `<application>` en `res/../AndroidManifest.xml`, y los 3 `<uses-permission>` (comentados en
   ese archivo) arriba del todo.
3. **Abrir en la pestaña correcta al pulsar un widget.** En `MainActivity.java`:
   ```java
   @Override
   public void onNewIntent(android.content.Intent intent) {
     super.onNewIntent(intent);
     String go = intent.getStringExtra("go");
     if (go != null && getBridge() != null) {
       getBridge().getWebView().post(() ->
         getBridge().getWebView().evaluateJavascript(
           "window.activateTab && activateTab('" + go + "')", null));
     }
   }
   ```
4. Icono de estado para notificaciones: crea `res/drawable/ic_stat_icon.xml` (un icono
   blanco simple) o cambia `smallIcon` en `capacitor.config.json` por `ic_launcher`.

`app.js` ya llama a `WidgetBridge.save(...)` al refrescar el panel y programa las
notificaciones locales (`scheduleLocalNotifs`) cada vez que cambian eventos/tareas.

---

## 4. Compilar y probar (debug)

```bash
npm run cap:sync
npm run cap:open      # abre Android Studio
```

En Android Studio: conecta el móvil con **Depuración USB** y pulsa **Run ▶**.
Añade los widgets manteniendo pulsada la pantalla de inicio → *Widgets* → *Agenda JW*.

---

## 5. APK firmada (para instalar sin cable)

En Android Studio: **Build → Generate Signed Bundle / APK → APK** → crea un keystore
(guarda bien la contraseña) → variante **release**. Sale en
`android/app/release/app-release.apk`.

Cópiala al móvil y ábrela (permite *instalar apps de orígenes desconocidos* para tu
gestor de archivos). **No hace falta Play Store.**

> Recuerda añadir el **SHA-1 de release** al cliente OAuth de Android (paso 2.1) o el
> login fallará solo en la APK firmada.

---

## 6. Cada vez que cambies la web

```bash
npm run cap:copy      # recopia www/ al proyecto Android
```
y reconstruye la APK. Nada de esto afecta a tu GitHub Pages.
