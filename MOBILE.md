# Hourglass como app Android privada (APK) con widgets

Esta guía convierte la web en una **APK que instalas tú por sideload** (sin publicar en Play
Store) usando **Capacitor**, y añade **widgets nativos** para la pantalla de inicio.

> Resumen honesto del coste:
> - Empaquetar la APK con Capacitor: ~1–2 h la primera vez.
> - Rehacer el **login de Google** para que funcione dentro de la app: es el punto delicado
>   (hay que crear un cliente OAuth de **Android** en Google Cloud y cambiar ~20 líneas de `app.js`).
> - **Widgets nativos**: código Kotlin + probar en un móvil real. ~1 día por los 3 widgets.

---

## 0. Requisitos en tu PC (Windows vale)

- **Node.js 18+** — https://nodejs.org
- **JDK 17** (Temurin) — https://adoptium.net
- **Android Studio** (incluye el SDK de Android) — https://developer.android.com/studio
  - Ábrelo una vez y deja que instale *Android SDK Platform* + *Build-Tools*.

---

## 1. Añadir Capacitor al proyecto

Desde la carpeta del repo:

```bash
npm init -y
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap init "Hourglass" "org.hourglass.panel" --web-dir "."
```

Esto crea `capacitor.config.json`. Déjalo así (la web se sirve desde dentro de la app):

```json
{
  "appId": "org.hourglass.panel",
  "webDir": ".",
  "server": { "androidScheme": "https" }
}
```

`webDir: "."` empaqueta `index.html`, `app.js`, `style.css`, `manifest.json`, `sw.js`,
`icon-*.png`. Si no quieres meter la carpeta `muestras/` en la APK, muévela fuera o crea
un `www/` con solo los archivos necesarios y pon `"webDir": "www"`.

```bash
npx cap add android
```

Iconos de la app (usa el PNG que ya hay como fuente):

```bash
npm install -D @capacitor/assets
npx capacitor-assets generate --iconBackgroundColor "#1E2A38" --iconBackgroundColorDark "#1E2A38"
```
(pon `icon-512.png` en `resources/icon.png` antes, 1024×1024 mejor).

---

## 2. El login de Google dentro de la APK  ⚠️ importante

El código actual usa **Google Identity Services (GIS) para web**:

```js
tokenClient = google.accounts.oauth2.initTokenClient({ client_id, scope, callback });
tokenClient.requestAccessToken({ prompt: 'consent' });
```

Dentro de un WebView de Android, Google **bloquea** ese consentimiento
(`disallowed_useragent`). Hay que hacer el login con el **SDK nativo** y pasarle a la app
el `access_token` que ya usa el resto del código.

### 2.1 En Google Cloud Console

1. *APIs & Services → Credentials → Create credentials → OAuth client ID* → tipo **Android**.
   - *Package name*: `org.hourglass.panel`
   - *SHA-1*: saca el de tu keystore de depuración y el de release:
     ```bash
     keytool -list -v -keystore "%USERPROFILE%\.android\debug.keystore" -alias androiddebugkey -storepass android -keypass android
     ```
2. Mantén también el cliente **Web** que ya tienes (su Client ID se usa como
   `serverClientId`).
3. En *OAuth consent screen* añade tu correo como *test user* (ya lo tienes).

### 2.2 Plugin de login

```bash
npm install @codetrix-studio/capacitor-google-auth
```

`capacitor.config.json`:

```json
{
  "appId": "org.hourglass.panel",
  "webDir": ".",
  "plugins": {
    "GoogleAuth": {
      "scopes": ["https://www.googleapis.com/auth/drive.file"],
      "serverClientId": "989709837307-449de0hk767r7lplvjfc4ilfb6smnpfd.apps.googleusercontent.com",
      "forceCodeForRefreshToken": true
    }
  }
}
```

### 2.3 Cambios en `app.js`

Envuelve el login para que use el plugin cuando corre dentro de Capacitor y siga usando GIS
en el navegador normal:

```js
const IS_NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

async function nativeSignIn() {
  const { GoogleAuth } = window.Capacitor.Plugins;
  await GoogleAuth.initialize();               // una vez
  const user = await GoogleAuth.signIn();
  accessToken = user.authentication.accessToken;
  localStorage.setItem('hg_token', accessToken);
  localStorage.setItem('hg_token_ts', Date.now().toString());
  await onSignedIn();
}

// en initAuth():
$('#signInBtn').addEventListener('click', () => {
  if (IS_NATIVE) nativeSignIn();
  else tokenClient.requestAccessToken({ prompt: 'consent' });
});
```

Cuando el token caduque (~50 min) el `driveFetch` dará 401 → vuelve a llamar a
`nativeSignIn()` (o `GoogleAuth.refresh()`).

Todo lo demás (llamadas REST a Drive con `fetch` y `Authorization: Bearer`) **no cambia**.

---

## 3. Compilar la APK

```bash
npx cap sync android
npx cap open android      # abre Android Studio
```

En Android Studio:
- **Debug** para probar: *Run ▶* con el móvil conectado (Depuración USB activada).
- **APK firmada** para instalar sin cable:
  *Build → Generate Signed Bundle / APK → APK*, crea un keystore, guarda la contraseña,
  elige *release*. La APK sale en `android/app/release/app-release.apk`.

Instálala en el móvil: cópiala y ábrela (permite "instalar apps desconocidas" para tu
gestor de archivos). No hace falta Play Store.

---

## 4. Widgets de pantalla de inicio (nativos)

Los widgets son código Android; el WebView no puede pintarlos. El patrón:

1. La web guarda un resumen en `SharedPreferences` cada vez que cambian los datos.
2. Un `AppWidgetProvider` en Kotlin lee ese resumen y pinta el widget.
3. Tocar el widget abre la app en la pestaña correspondiente (`?go=...`, ya soportado).

### 4.1 Puente web → nativo (plugin mínimo)

`android/app/src/main/java/org/hourglass/panel/WidgetBridge.kt`:

```kotlin
package org.hourglass.panel

import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import android.appwidget.AppWidgetManager
import android.content.ComponentName

@CapacitorPlugin(name = "WidgetBridge")
class WidgetBridge : Plugin() {
  @PluginMethod
  fun save(call: PluginCall) {
    val ctx = context
    ctx.getSharedPreferences("hg_widgets", 0).edit()
      .putString("hoy", call.getString("hoy", "[]"))
      .putString("reunion", call.getString("reunion", ""))
      .putString("horas", call.getString("horas", ""))
      .apply()
    val mgr = AppWidgetManager.getInstance(ctx)
    for (cls in listOf(HoyWidget::class.java, ReunionWidget::class.java, HorasWidget::class.java)) {
      val ids = mgr.getAppWidgetIds(ComponentName(ctx, cls))
      ctx.sendBroadcast(android.content.Intent(ctx, cls).apply {
        action = AppWidgetManager.ACTION_APPWIDGET_UPDATE
        putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids)
      })
    }
    call.resolve()
  }
}
```

Regístralo en `MainActivity.java`: `registerPlugin(WidgetBridge.class);`

En `app.js`, al final de `renderDashboard()`:

```js
if (window.Capacitor?.Plugins?.WidgetBridge) {
  const hoy = tareasHoyPend().slice(0, 4).map(t => t.title)
    .concat(findMyAssignments(currentHistorial, (nameInput.value||'').trim())
      .filter(m => assignmentDateISO(m.fecha) === todayISO()).map(m => m.categoria));
  const next = deriveMeetings().filter(m => m.iso >= todayISO())
    .sort((a,b)=>a.iso.localeCompare(b.iso))[0];
  window.Capacitor.Plugins.WidgetBridge.save({
    hoy: JSON.stringify(hoy),
    reunion: next ? `${next.label} · ${next.iso}` : '',
    horas: fmtDur(ministerioTotals().mes),
  });
}
```

### 4.2 Widget "Hoy"  (los otros dos son iguales cambiando el texto)

`android/app/src/main/res/xml/hoy_widget_info.xml`:

```xml
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
  android:minWidth="180dp" android:minHeight="110dp"
  android:updatePeriodMillis="1800000"
  android:initialLayout="@layout/hoy_widget"
  android:resizeMode="horizontal|vertical" android:widgetCategory="home_screen" />
```

`res/layout/hoy_widget.xml`: un `LinearLayout` con un `TextView` de título ("Hoy") y otro
`@+id/hoy_body`.

`HoyWidget.kt`:

```kotlin
package org.hourglass.panel

import android.app.PendingIntent
import android.appwidget.*
import android.content.*
import android.widget.RemoteViews
import org.json.JSONArray

class HoyWidget : AppWidgetProvider() {
  override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
    val prefs = ctx.getSharedPreferences("hg_widgets", 0)
    val arr = JSONArray(prefs.getString("hoy", "[]"))
    val body = if (arr.length() == 0) "Nada para hoy"
               else (0 until minOf(arr.length(), 4)).joinToString("\n") { "• " + arr.getString(it) }
    val open = PendingIntent.getActivity(ctx, 0,
      ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)!!
        .apply { putExtra("go", "inicio") },
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    for (id in ids) {
      val v = RemoteViews(ctx.packageName, R.layout.hoy_widget)
      v.setTextViewText(R.id.hoy_body, body)
      v.setOnClickPendingIntent(R.id.hoy_body, open)
      mgr.updateAppWidget(id, v)
    }
  }
}
```

Declara los 3 en `AndroidManifest.xml` dentro de `<application>`:

```xml
<receiver android:name=".HoyWidget" android:exported="false">
  <intent-filter><action android:name="android.appwidget.action.APPWIDGET_UPDATE"/></intent-filter>
  <meta-data android:name="android.appwidget.provider" android:resource="@xml/hoy_widget_info"/>
</receiver>
```

`ReunionWidget` lee `prefs.getString("reunion")`, `HorasWidget` lee `"horas"`. Mismo esqueleto.

Para abrir en la pestaña correcta al pulsar: en `MainActivity` lee `intent.getStringExtra("go")`
y navega a `index.html?go=<valor>` (o usa `Bridge.getWebView().evaluateJavascript("activateTab('...')", null)`).

---

## 5. Actualizar la app luego

Cada vez que cambies `app.js` / `index.html` / `style.css`:

```bash
npx cap copy android
```
y reconstruye la APK. (Nada de esto toca tu GitHub Pages, que sigue funcionando como web.)
