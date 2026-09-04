/* Copia solo los archivos necesarios de la web a www/ para empaquetar la APK.
   (Deja fuera muestras/, node_modules, mobile/, etc.) */
import { mkdir, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const FILES = [
  'index.html', 'app.js', 'style.css',
  'manifest.json', 'sw.js',
  'icon-192.png', 'icon-512.png', 'icon-maskable-512.png',
];

await rm('www', { recursive: true, force: true });
await mkdir('www', { recursive: true });
for (const f of FILES) {
  if (existsSync(f)) await cp(f, `www/${f}`);
  else console.warn('  (falta)', f);
}
console.log('www/ listo con', FILES.length, 'archivos');
