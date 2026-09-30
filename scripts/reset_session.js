'use strict';
// OrbitaOs - rescate del perfil de Chromium.

const fs = require('fs');
const path = require('path');

const SESSION_PATH = process.env.SESSION_PATH || path.join(__dirname, '..', 'session');
const PROFILE = path.join(SESSION_PATH, 'session-orbitaos');

const args = process.argv.slice(2);
const force = args.includes('--force');
const soloListar = args.includes('--list');

function listar() {
  if (!fs.existsSync(PROFILE)) {
    console.log(`El perfil no existe todavia: ${PROFILE}`);
    console.log('Se creara solo en el primer arranque.');
    return [];
  }
  const entradas = fs.readdirSync(PROFILE);
  console.log(`\nPerfil: ${PROFILE}`);
  console.log(`Entradas: ${entradas.length}\n`);
  for (const e of entradas) {
    let info;
    try {
      const st = fs.lstatSync(path.join(PROFILE, e));
      info = `${st.isDirectory() ? 'dir ' : 'arch'} ${st.size}B uid=${st.uid} gid=${st.gid}`;
      if (e.startsWith('Singleton')) {
        let objetivo;
        try {
          objetivo = ' -> ' + fs.readlinkSync(path.join(PROFILE, e));
        } catch (_) {
          objetivo = ' (archivo comun)';
        }
        info += `  <-- LOCK${objetivo}`;
      }
    } catch (err) {
      info = `ilegible (${err.code})`;
    }
    console.log(`  ${e}  ${info}`);
  }
  console.log('');
  return entradas;
}

console.log('=== OrbitaOs: rescate del perfil de Chromium ===\n');

const entradas = listar();

if (soloListar) {
  process.exit(0);
}

const locks = entradas.filter((e) => e.startsWith('Singleton'));
if (locks.length) {
  console.log(`Locks encontrados: ${locks.join(', ')}`);
} else {
  console.log('No hay locks visibles. El perfil puede seguir corrupto.');
}

if (!force) {
  console.log('\nEsto BORRA el perfil y la sesion de WhatsApp.');
  console.log('Para confirmar, reejecuta con --force:');
  console.log('  docker compose exec orbitaos node scripts/reset_session.js --force\n');
  process.exit(0);
}

try {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  console.log(`\nPerfil reiniciado: ${PROFILE}`);
  console.log('Ahora reinicia el servicio: el navegador deberia arrancar limpio.');
} catch (err) {
  console.error(`\nNo se pudo borrar (${err.code}): ${err.message}`);
  console.error('\nProbablemente los archivos son de root. Ejecutalo como root:');
  console.error('  docker compose exec -u root orbitaos node scripts/reset_session.js --force');
  console.error('\nO borra la carpeta de sesion y vuelve a vincular.');
  process.exit(1);
}
