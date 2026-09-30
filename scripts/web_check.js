'use strict';
// OrbitaOs - prueba de la API del panel de punta a punta.

const assert = require('assert');
const http = require('http');

const URI =
  process.env.MONGO_URI || 'mongodb://localhost:27017/orbitaos_web_test';
process.env.MONGO_URI = URI;
process.env.WHITELIST = '';

const db = require('../src/database');
const usuarios = require('../src/users');
const health = require('../src/health_server');

const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;

const USUARIO = 'webcheck';
const CLAVE = 'clave-de-prueba-123';
const TEL = '595900000000';
const TEL_CONTACTO = '595900000001';

let cookie = null;
let passed = 0;

/** Peticion HTTP con la cookie de sesion. */
function pedir(ruta, opciones = {}) {
  return new Promise((resolve, reject) => {
    const cabeceras = { ...(opciones.cabeceras || {}) };
    if (opciones.cuerpo) cabeceras['Content-Type'] = 'application/json';
    if (cookie) cabeceras.Cookie = cookie;

    const req = http.request(
      `${BASE}${ruta}`,
      { method: opciones.metodo || 'GET', headers: cabeceras },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch (_) {
            json = null;
          }
          resolve({ status: res.statusCode, body: data, json, cabeceras: res.headers });
        });
      }
    );
    req.on('error', reject);
    if (opciones.cuerpo) req.write(JSON.stringify(opciones.cuerpo));
    req.end();
  });
}

async function check(nombre, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${nombre}`);
  } catch (err) {
    console.error(`  FAIL ${nombre}: ${err.message}`);
    process.exitCode = 1;
  }
}

/** Borra todo lo que la prueba pudo haber creado. */
async function limpiar() {
  await Promise.all([
    db.Task.deleteMany({ createdBy: USUARIO }),
    db.Event.deleteMany({ createdBy: USUARIO }),
    db.ScheduledMessage.deleteMany({ createdBy: USUARIO }),
    db.Message.deleteMany({ chatId: { $in: [TEL, TEL_CONTACTO] } }),
    db.User.deleteMany({ username: { $in: [USUARIO, `c${TEL_CONTACTO}`] } }),
  ]);
}

(async () => {
  console.log('\nAPI del panel\n');

  try {
    await db.connect(URI);
  } catch (err) {
    console.log(`  --  sin MongoDB (${err.message.split('\n')[0]})`);
    console.log('  --  se omite la prueba de la API\n');
    process.exit(0);
  }

  await limpiar();

  await usuarios.createUser({
    username: USUARIO,
    password: CLAVE,
    name: 'Prueba Web',
    firstName: 'Prueba',
    lastName: 'Web',
    phone: TEL,
    role: 'owner',
  });

  const server = await health.startHealthServer({ port: PORT });
  health.setReady(true);

  let idContacto = null;
  let idEvento = null;
  let idTarea = null;
  let idProgramado = null;

  try {
    await check('el panel se sirve', async () => {
      const r = await pedir('/');
      assert.strictEqual(r.status, 200);
      assert.ok(r.body.includes('OrbitaOs'));
    });

    await check('login con credenciales validas devuelve cookie', async () => {
      const r = await pedir('/api/login', {
        metodo: 'POST',
        cuerpo: { username: USUARIO, password: CLAVE },
      });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.usuario.username, USUARIO);

      const puesta = r.cabeceras['set-cookie'];
      assert.ok(Array.isArray(puesta) && puesta.length, 'debe venir Set-Cookie');
      cookie = puesta[0].split(';')[0];
      assert.ok(cookie.startsWith('orbita_sesion='), 'la cookie debe ser la de sesion');
      assert.ok(
        puesta[0].toLowerCase().includes('httponly'),
        'la cookie debe ser httpOnly'
      );
    });

    await check('login con clave incorrecta no da sesion', async () => {
      const guardada = cookie;
      cookie = null;
      const r = await pedir('/api/login', {
        metodo: 'POST',
        cuerpo: { username: USUARIO, password: 'incorrecta' },
      });
      cookie = guardada;
      assert.strictEqual(r.status, 401);
    });

    await check('/api/sesion devuelve el usuario', async () => {
      const r = await pedir('/api/sesion');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.usuario.username, USUARIO);
      assert.ok(!r.body.includes('passwordHash'), 'no debe salir el hash');
    });

    await check('/api/estado informa el estado del sistema', async () => {
      const r = await pedir('/api/estado');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.sistema, 'OrbitaOs');
      assert.strictEqual(r.json.base, 'conectada');
      assert.ok(r.json.uso_ia, 'debe traer el consumo');
      assert.ok(r.json.conteos, 'debe traer los conteos');
    });

    await check('/api/resumen arma el panel de inicio', async () => {
      const r = await pedir('/api/resumen');
      assert.strictEqual(r.status, 200);
      assert.ok(r.json.estado, 'debe traer el estado');
      assert.ok(Array.isArray(r.json.tablero), 'debe traer el resumen del tablero');
      assert.strictEqual(r.json.tablero.length, 5, 'el tablero tiene 5 columnas');
    });

    await check('crear y listar contactos', async () => {
      const c = await pedir('/api/contactos', {
        metodo: 'POST',
        cuerpo: { phone: TEL_CONTACTO, name: 'Contacto Prueba', role: 'member' },
      });
      assert.strictEqual(c.status, 201, c.body);
      idContacto = c.json.contacto.id;

      const l = await pedir('/api/contactos?q=Contacto');
      assert.strictEqual(l.status, 200);
      assert.ok(l.json.contactos.some((x) => x.id === idContacto));
      assert.ok(!l.body.includes('passwordHash'), 'nunca debe salir el hash');
    });

    await check('crear y listar eventos', async () => {
      const e = await pedir('/api/eventos', {
        metodo: 'POST',
        cuerpo: { title: 'Prueba calendario', startAt: '2026-03-15T10:00' },
      });
      assert.strictEqual(e.status, 201, e.body);
      idEvento = e.json.evento._id;

      const l = await pedir('/api/eventos?desde=2026-03-01&hasta=2026-03-31');
      assert.strictEqual(l.status, 200);
      assert.ok(l.json.eventos.some((x) => x._id === idEvento));
    });

    await check('crear, agrupar y mover tareas', async () => {
      const t = await pedir('/api/tareas', {
        metodo: 'POST',
        cuerpo: { title: 'Tarea de prueba', status: 'todo' },
      });
      assert.strictEqual(t.status, 201, t.body);
      idTarea = t.json.tarea._id;

      const g = await pedir('/api/tareas');
      assert.strictEqual(g.status, 200);
      assert.strictEqual(g.json.tablero.length, 5, 'siempre 5 columnas');
      assert.ok(
        g.json.tablero
          .find((col) => col.columna === 'todo')
          .tareas.some((x) => x._id === idTarea)
      );

      const m = await pedir(`/api/tareas/${idTarea}`, {
        metodo: 'PATCH',
        cuerpo: { status: 'done' },
      });
      assert.strictEqual(m.status, 200, m.body);
      assert.strictEqual(m.json.tarea.status, 'done');
    });

    await check('crear y listar programados con proximo envio', async () => {
      const p = await pedir('/api/programados', {
        metodo: 'POST',
        cuerpo: {
          to: TEL_CONTACTO,
          body: 'Feliz cumple {nombre}',
          title: 'Cumple de prueba',
          mode: 'yearly',
          month: 7,
          day: 4,
          time: '09:00',
        },
      });
      assert.strictEqual(p.status, 201, p.body);
      idProgramado = p.json.programado.id;
      assert.ok(p.json.programado.proximo_envio, 'debe calcular el proximo envio');
      assert.ok(p.json.programado.proximo_envio.includes('07-04'));

      const l = await pedir('/api/programados');
      assert.strictEqual(l.status, 200);
      assert.ok(l.json.programados.some((x) => x.id === idProgramado));
    });

    await check('valida los campos obligatorios', async () => {
      const r = await pedir('/api/tareas', { metodo: 'POST', cuerpo: {} });
      assert.strictEqual(r.status, 400);
      assert.ok(r.json.error.includes('título'));
    });

    await check('borrar recursos', async () => {
      const rutas = [
        [`/api/tareas/${idTarea}`, idTarea],
        [`/api/eventos/${idEvento}`, idEvento],
        [`/api/programados/${idProgramado}`, idProgramado],
        [`/api/contactos/${idContacto}`, idContacto],
      ];
      for (const [ruta, id] of rutas) {
        const r = await pedir(ruta, { metodo: 'DELETE' });
        assert.strictEqual(r.status, 200, `${ruta} respondio ${r.status}`);
      }
    });

    await check('logout cierra la sesion', async () => {
      const r = await pedir('/api/logout', { metodo: 'POST' });
      assert.strictEqual(r.status, 200);
      cookie = null;
      const s = await pedir('/api/estado');
      assert.strictEqual(s.status, 401, 'sin cookie debe quedar protegido');
    });
  } finally {
    await limpiar();
    await new Promise((resolve) => server.close(resolve));
    await db.disconnect();
  }

  console.log(`\n${passed} comprobaciones OK\n`);
})();
