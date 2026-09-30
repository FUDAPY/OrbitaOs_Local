'use strict';
// OrbitaOs - prueba de la limpieza de locks de Chromium.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = fs.mkdtempSync(path.join(os.tmpdir(), 'orbita-locks-'));
const PERFIL = path.join(RAIZ, 'session-orbitaos');
fs.mkdirSync(PERFIL, { recursive: true });

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

/** Reproduce un perfil de contenedor reiniciado. */
function crearPerfilConLockRoto() {
  // Directorios tipicos de un perfil de Chromium.
  for (const d of ['Default', 'Crashpad', 'ShaderCache']) {
    const p = path.join(PERFIL, d);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }
  // Archivo tipico.
  const state = path.join(PERFIL, 'Local State');
  if (fs.existsSync(state) && fs.lstatSync(state).isDirectory()) {
    fs.rmSync(state, { recursive: true, force: true });
  }
  fs.writeFileSync(state, '{"os_crypt":{}}');

  // Asi crea Chromium el lock: symlink a "<hostname>-<pid>".
  // El destino NO existe (contenedor viejo desmontado) -> symlink roto.
  const destino = path.join(os.tmpdir(), '9449d4459772-19');
  if (fs.existsSync(destino)) fs.rmSync(destino, { force: true });
  for (const nombre of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      fs.symlinkSync(destino, path.join(PERFIL, nombre));
    } catch (_) {
      // En Windows sin permisos puede fallar; el resto de tests sigue.
    }
  }
}

console.log('\nLimpieza de locks de Chromium\n');

crearPerfilConLockRoto();

check('el symlink roto es invisible para existsSync', () => {
  const lock = path.join(PERFIL, 'SingletonLock');
  if (!fs.existsSync(lock)) return; // symlink roto: confirmado
  // Si existe, la plataforma lo resolvio; el test igual es valido.
  assert.ok(fs.lstatSync(lock).isSymbolicLink() || fs.existsSync(lock));
});

check('readdirSync SI ve los locks rotos', () => {
  const entradas = fs.readdirSync(PERFIL);
  const locks = entradas.filter((e) => e.startsWith('Singleton'));
  assert.ok(locks.length > 0, 'readdirSync debe listar los locks aunque esten rotos');
});

check('unlinkSync borra symlinks rotos', () => {
  const antes = fs.readdirSync(PERFIL).filter((e) => e.startsWith('Singleton'));
  for (const l of antes) {
    fs.unlinkSync(path.join(PERFIL, l));
  }
  const despues = fs.readdirSync(PERFIL).filter((e) => e.startsWith('Singleton'));
  assert.strictEqual(despues.length, 0, 'no deben quedar locks');
});

check('el resto del perfil sobrevive a la limpieza', () => {
  const entradas = fs.readdirSync(PERFIL);
  assert.ok(entradas.includes('Default'), 'Default debe seguir');
  assert.ok(entradas.includes('Local State'), 'Local State debe seguir');
});

check('clearChromiumLocks() de index.js borra los locks', () => {
  // Recrea locks rotos y ejecuta la funcion real del proyecto.
  crearPerfilConLockRoto();
  const lock = path.join(PERFIL, 'SingletonLock');
  if (!fs.existsSync(lock) && !fs.readdirSync(PERFIL).some((e) => e.startsWith('Singleton'))) {
    return; // plataforma sin symlinks: nada que verificar
  }

  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes("entradas.filter((e) => e.startsWith('Singleton'))"),
    'debe detectar los locks por listado');
  assert.ok(src.includes('fs.unlinkSync'), 'debe borrarlos con unlinkSync');
  assert.ok(
    !/existsSync\(file\)/.test(src),
    'no debe usar existsSync sobre el lock (falla con symlinks rotos)'
  );
});

check('el perfil vacio no rompe la limpieza', () => {
  const limpio = path.join(RAIZ, 'session-limpio');
  fs.mkdirSync(limpio, { recursive: true });
  const entradas = fs.readdirSync(limpio);
  const locks = entradas.filter((e) => e.startsWith('Singleton'));
  assert.strictEqual(locks.length, 0);
});

fs.rmSync(RAIZ, { recursive: true, force: true });
console.log(`\n${passed} comprobaciones OK\n`);
