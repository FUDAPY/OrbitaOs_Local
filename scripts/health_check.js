'use strict';
// OrbitaOs - prueba del servidor HTTP.

const assert = require('assert');
const http = require('http');

process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/orbitaos_test';
process.env.WHITELIST = '';
delete process.env.SPACE_BUNNY_API_KEY;

const health = require('../src/health_server');
const sesion = require('../src/session');

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;

// Peticion HTTP simple.
function pedir(ruta, opciones = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${BASE}${ruta}`,
      { method: opciones.metodo || 'GET', headers: opciones.cabeceras || {} },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: data, cabeceras: res.headers })
        );
      }
    );
    req.on('error', reject);
    if (opciones.cuerpo) req.write(JSON.stringify(opciones.cuerpo));
    req.end();
  });
}

/** Peticion con una sesion valida ya creada. */
function pedirConSesion(ruta, usuario = { username: 'prueba', role: 'owner' }) {
  const token = sesion.crear({ name: 'Prueba', ...usuario });
  return pedir(ruta, { cabeceras: { Cookie: `${sesion.COOKIE}=${token}` } });
}

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

(async () => {
  console.log('\nServidor HTTP\n');
  const server = await health.startHealthServer({ port: PORT });

  await check('/health responde 200 con "ok"', async () => {
    const r = await pedir('/health');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.trim(), 'ok');
  });

  await check('/healthz tambien responde (alias)', async () => {
    const r = await pedir('/healthz');
    assert.strictEqual(r.status, 200);
  });

  await check('/ sirve el panel', async () => {
    const r = await pedir('/');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('<html'), 'debe ser HTML');
    assert.ok(r.body.includes('Orbita'), 'debe traer la marca');
    assert.ok(
      String(r.cabeceras['content-type']).includes('text/html'),
      'debe declararse como HTML'
    );
  });

  await check('los estaticos del panel se sirven con su tipo', async () => {
    const css = await pedir('/app.css');
    assert.strictEqual(css.status, 200);
    assert.ok(String(css.cabeceras['content-type']).includes('text/css'));

    const js = await pedir('/app.js');
    assert.strictEqual(js.status, 200);
    assert.ok(String(js.cabeceras['content-type']).includes('javascript'));
  });

  await check('un archivo inexistente responde 404 en JSON', async () => {
    const r = await pedir('/no-existe');
    assert.strictEqual(r.status, 404);
    const j = JSON.parse(r.body);
    assert.ok(j.error, 'debe traer el campo error');
    assert.ok(Array.isArray(j.rutas), 'debe listar las rutas validas');
  });

  await check('no se puede salir de public/ con ..', async () => {
    const r = await pedir('/../index.js');
    // Lo importante es que no entregue codigo de src/.
    assert.ok(!r.body.includes('startHealthServer'), 'no debe servir codigo de src');
  });

  await check('/api/estado exige sesion', async () => {
    const r = await pedir('/api/estado');
    assert.strictEqual(r.status, 401);
  });

  await check('una cookie inventada no da acceso', async () => {
    const r = await pedir('/api/estado', {
      cabeceras: { Cookie: 'orbita_sesion=0000000000000000' },
    });
    assert.strictEqual(r.status, 401);
  });

  await check('una ruta de la API que no existe responde 404', async () => {
    const r = await pedir('/api/no-existe');
    assert.strictEqual(r.status, 404);
    assert.ok(JSON.parse(r.body).error);
  });

  await check('/api/login sin datos responde 400', async () => {
    const r = await pedir('/api/login', { metodo: 'POST', cuerpo: {} });
    assert.strictEqual(r.status, 400);
  });

  await check('la API no expone el hash de contrasena', async () => {
    const r = await pedirConSesion('/api/sesion');
    assert.strictEqual(r.status, 200);
    assert.ok(!r.body.includes('passwordHash'), 'nunca debe salir el hash');
  });

  await new Promise((resolve) => server.close(resolve));
  console.log(`\n${passed} comprobaciones OK\n`);
})();

