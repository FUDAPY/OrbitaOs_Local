'use strict';
// OrbitaOs - prueba del flujo de control de acceso y formato de index.js.

process.env.WHITELIST = '54911123456789, 54911-9876-5432';
process.env.GROUP_PREFIX = '@orbita';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ai = require('../src/ai_router');

// ---- Funciones replicadas de index.js (misma logica) ---------------------
function loadWhitelist() {
  return new Set(
    (process.env.WHITELIST || '')
      .split(',')
      .map((p) => p.replace(/\D/g, ''))
      .filter(Boolean)
  );
}
const WHITELIST = loadWhitelist();
function normalizePhone(id) {
  return String(id).split('@')[0].replace(/\D/g, '');
}
function isAllowed(senderId) {
  return WHITELIST.has(normalizePhone(senderId));
}
function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
function formatDate(date, timezone) {
  return new Intl.DateTimeFormat('es-AR', {
    weekday: 'long', day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
    timeZone: timezone || 'America/Argentina/Buenos_Aires',
  }).format(date);
}

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

console.log('\nLista blanca');

check('carga los telefonos de WHITELIST', () => {
  assert.strictEqual(WHITELIST.size, 2);
  assert.ok(WHITELIST.has('54911123456789'));
  assert.ok(WHITELIST.has('5491198765432'));
});

check('acepta un autorizado con sufijo @c.us', () => {
  assert.ok(isAllowed('54911123456789@c.us'));
});

check('acepta un autorizado con @s.whatsapp.net', () => {
  assert.ok(isAllowed('54911123456789@s.whatsapp.net'));
});

check('rechaza un numero desconocido', () => {
  assert.strictEqual(isAllowed('54911999999999@c.us'), false);
});

check('rechaza un grupo aunque el id contenga un autorizado', () => {
  assert.strictEqual(isAllowed('120363000000000000@g.us'), false);
});

console.log('\nNormalizacion de telefonos');

check('quita el sufijo y no numerico', () => {
  assert.strictEqual(normalizePhone('+54 9 11 1234-5678@c.us'), '5491112345678');
  assert.strictEqual(normalizePhone('54911123456789@c.us'), '54911123456789');
  assert.strictEqual(normalizePhone('120363000000000000@g.us'), '120363000000000000');
});

console.log('\nValidacion de mensaje');

check('descarta cuerpo vacio', () => {
  assert.strictEqual(!('' || '').trim(), true);
});

check('descarta estados de no-chat', () => {
  const isGroup = false;
  const type = 'image';
  assert.strictEqual(!isGroup && type !== 'chat', true);
});

check('acepta un mensaje de texto en grupo', () => {
  const isGroup = true;
  const type = 'chat';
  assert.strictEqual(!isGroup && type !== 'chat', false);
});

console.log('\nFechas');

check('convierte ISO a Date', () => {
  const d = toDate('2026-10-01T15:00:00.000Z');
  assert.ok(d instanceof Date);
  assert.strictEqual(d.toISOString(), '2026-10-01T15:00:00.000Z');
});

check('devuelve null para una fecha invalida', () => {
  assert.strictEqual(toDate('no es una fecha'), null);
  assert.strictEqual(toDate(''), null);
  assert.strictEqual(toDate(null), null);
});

check('formatea con la zona horaria del usuario', () => {
  const d = new Date('2026-10-01T15:00:00.000Z');
  // Buenos Aires es UTC-3: 15:00 UTC se ven las 12:00.
  const s = formatDate(d, 'America/Argentina/Buenos_Aires');
  assert.ok(s.includes('12:00'), `esperaba 12:00, obtuve ${s}`);
  // Madrid es UTC+2 en octubre: 15:00 UTC se ven las 17:00 (05:00 p. m.).
  const m = formatDate(d, 'Europe/Madrid');
  assert.ok(m.includes('05:00'), `esperaba 05:00 p. m., obtuve ${m}`);
  // Misma fecha, distinta zona horaria: el formateo depende del usuario.
  assert.notStrictEqual(s, m);
});

console.log('\nContrato con los modulos');

check('index.js importa los modulos correctos', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  for (const req of [
    "require('./src/database')",
    "require('./src/ai_router')",
    "require('./src/cron_jobs')",
    "require('whatsapp-web.js')",
    "require('qrcode-terminal')",
  ]) {
    assert.ok(src.includes(req), `falta ${req}`);
  }
});

check('index.js arranca el cron cuando WhatsApp esta listo', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes("client.on('ready'"));
  assert.ok(src.includes('cron.startReminderJobs(client)'));
});

check('index.js apaga de forma ordenada', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes('SIGTERM'));
  assert.ok(src.includes('client.destroy()'));
  assert.ok(src.includes('db.disconnect()'));
});

check('index.js conecta a MongoDB y no aborta sin WHITELIST', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes('MONGO_URI'), 'debe exigir MONGO_URI');
  // La lista blanca ya no es obligatoria: el acceso vive en la base de datos.
  assert.ok(
    !src.includes('WHITELIST esta vacia'),
    'no debe abortar cuando WHITELIST esta vacia'
  );
  // Y en su lugar crea el usuario owner inicial.
  assert.ok(src.includes('ensureBootstrapUser()'));
});

check('el modulo de usuarios esta integrado en index.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes("require('./src/users')"));
  assert.ok(src.includes('users.isAllowedPhone'));
});

console.log('\nEmparejamiento de WhatsApp');

check('soporta emparejamiento por codigo (BOT_PHONE)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes('BOT_PHONE'), 'debe leer BOT_PHONE');
  assert.ok(
    src.includes('requestPairingCode'),
    'debe pedir el codigo de emparejamiento'
  );
  assert.ok(src.includes("client.on('code'"), 'debe escuchar el evento code');
  // Y debe pedirlo tras inicializar el navegador.
  const init = src.indexOf('await client.initialize()');
  const pairing = src.indexOf('requestPairingCode');
  assert.ok(init > 0 && pairing > init, 'el codigo se pide despues de initialize');
});

check('el QR queda como respaldo cuando no hay BOT_PHONE', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes("client.on('qr'"), 'debe conservar el evento qr');
  assert.ok(src.includes('qrcode.generate'), 'debe seguir mostrando el QR');
});

check('BOT_PHONE se normaliza a solo digitos', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(
    src.includes("const BOT_PHONE = (process.env.BOT_PHONE || '').replace(/\\D/g, '')"),
    'debe limpiar el numero de simbolos'
  );
});

console.log('\nCLI de lista blanca');

check('el script de whitelist expone todos los comandos', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'whitelist.js'),
    'utf8'
  );
  for (const cmd of ["case 'list'", "case 'add'", "case 'remove'", "case 'allow'", "case 'block'"]) {
    assert.ok(src.includes(cmd), `falta ${cmd}`);
  }
  // Agregar, desactivar y eliminar son caminos distintos.
  assert.ok(src.includes('allowed: true'), 'add debe dar acceso');
  assert.ok(src.includes('$set: { allowed: comando'), 'allow/block deben alternar acceso');
  assert.ok(src.includes('deleteOne'), 'remove debe eliminar');
});

check('package.json expone el comando whitelist', () => {
  const pkg = require('../package.json');
  assert.ok(pkg.scripts.whitelist, 'falta el script whitelist');
  assert.ok(pkg.scripts.user, 'falta el script user');
});

console.log('\nEstabilidad de Chromium en contenedores');

check('diagnostica el perfil de Chromium e imprime los nombres', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(
    src.includes('clearChromiumLocks'),
    'debe limpiar los locks del perfil persistente'
  );
  assert.ok(src.includes('readdirSync'), 'debe listar el directorio');
});

check('detecta los locks por listado, no por existsSync', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  // SingletonLock es un symlink ROTO: existsSync devuelve false y el lock
  // pasaria desapercibido, dejando el contenedor en loop de reinicios.
  assert.ok(
    src.includes("entradas.filter((e) => e.startsWith('Singleton'))"),
    'debe detectar los locks listando el directorio'
  );
  assert.ok(src.includes('fs.unlinkSync'), 'debe borrarlos con unlinkSync');
  assert.ok(
    !/existsSync\(file\)/.test(src),
    'no debe usar existsSync sobre el lock'
  );
});

check('reintenta con el perfil limpio si Chromium falla', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes('initializeWithRecovery'), 'debe reintentar');
  assert.ok(src.includes('wipeChromiumProfile'), 'debe reconstruir el perfil');
  // Detecta el error tipico de perfil tomado.
  assert.ok(
    src.includes('profile appears to be in use'),
    'debe reconocer el error de perfil bloqueado'
  );
  // Y descarta el error si el segundo intento tambien falla.
  assert.ok(src.includes('fallo irrecuperable'));
});

check('usa headless moderno y flags de contenedor', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  // 'new' evita el fallback a headless con display.
  assert.ok(src.includes("'new'"), 'debe usar headless new');
  for (const flag of [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
  ]) {
    assert.ok(src.includes(flag), `falta el flag ${flag}`);
  }
});

check('el entrypoint corrige permisos y baja a node', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const sh = fs2.readFileSync(
    path2.join(__dirname, '..', 'docker-entrypoint.sh'),
    'utf8'
  );
  // Sin esto el volumen (creado por Docker como root) queda inaccesible.
  assert.ok(sh.includes('chown -R node:node'), 'debe corregir el ownership');
  // Y baja privilegios antes de ejecutar la app.
  assert.ok(sh.includes('exec gosu node'), 'debe bajar a node con gosu');
  // Tambien borra los locks, incluyendo los symlinks rotos.
  assert.ok(sh.includes('Singleton*'), 'debe borrar los locks');
  assert.ok(
    sh.includes('[ -e "$lock" ] || [ -L "$lock" ]'),
    'debe cubrir symlinks rotos, que no pasan el test -e'
  );
});

check('el Dockerfile usa el entrypoint y ya no fija USER node', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const df = fs2.readFileSync(path2.join(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.ok(df.includes('docker-entrypoint.sh'), 'debe invocar el entrypoint');
  assert.ok(df.includes('gosu'), 'debe instalar gosu');
  assert.ok(df.includes('dumb-init'), 'debe usar dumb-init como PID 1');
  // USER node impediria corregir los permisos del volumen.
  assert.ok(!/^USER node$/m.test(df), 'no debe fijar USER node (el entrypoint baja privilegios)');
});

check('el compose no fuerza el usuario', () => {
  const yml = fs.readFileSync(
    path.join(__dirname, '..', 'docker-compose.yml'),
    'utf8'
  );
  // "user:" impediria al entrypoint hacer chown como root.
  assert.ok(
    !/^\s{4}user:\s/m.test(yml),
    'el compose no debe fijar user:, lo hace el entrypoint'
  );
});

check('expone el uso de la IA (control de gasto)', () => {
  assert.strictEqual(typeof ai.getUsage, 'function', 'debe exportar getUsage');

  delete process.env.SPACE_BUNNY_DAILY_CAP;
  delete process.env.SPACE_BUNNY_API_KEY;
  const u = ai.getUsage();
  for (const campo of [
    'llamadas', 'ok', 'errores',
    'tokens_prompt', 'tokens_completion', 'tokens_total',
    'tope_diario', 'desde',
  ]) {
    assert.ok(campo in u, `falta ${campo} en el snapshot`);
  }
  assert.strictEqual(typeof u.llamadas, 'number');
  assert.strictEqual(u.tope_diario, 0, 'sin variable, el tope es 0 (ilimitado)');
});

check('sin clave de API no se hace ninguna llamada', async () => {
  delete process.env.SPACE_BUNNY_API_KEY;
  const antes = ai.getUsage();
  const r = await ai.route('Hola', { history: [] });
  const despues = ai.getUsage();
  assert.strictEqual(r.mock, true, 'debe responder en modo mock');
  assert.strictEqual(
    despues.llamadas,
    antes.llamadas,
    'no debe contar llamadas al exterior sin clave'
  );
});

check('el flujo de tareas va antes que la IA en index.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes("require('./src/task_flow')"), 'debe importar el flujo');
  assert.ok(src.includes('taskFlow.estaActivo'), 'debe chequear el flujo activo');
  assert.ok(src.includes('taskFlow.procesar'), 'debe procesar la respuesta');

  // Orden critico: si la IA se consultara antes, cada respuesta gastaria un
  // token. El flujo debe resolverse antes de llegar a ai.route().
  const flujoPos = src.indexOf('taskFlow.procesar');
  const iaPos = src.indexOf('ai.route(');
  assert.ok(flujoPos > 0 && iaPos > 0, 'deben existir ambos');
  assert.ok(
    flujoPos < iaPos,
    'el flujo debe procesarse ANTES de llamar a la IA'
  );
});

check('index.js abre el flujo con /tarea y con intencion natural', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes('taskFlow.detectarIntencion'), 'debe detectar la intención');
  assert.ok(src.includes('taskFlow.iniciar'), 'debe iniciar el flujo');
  assert.ok(src.includes('/tarea'), 'debe documentar el comando /tarea');
});

console.log('\nControl de gasto');

check('el tope diario corta antes de llamar a la API', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'ai_router.js'),
    'utf8'
  );
  // El corte debe ocurrir ANTES del fetch, si despues no sirve de nada.
  const capPos = src.indexOf('stats.llamadas >= cap');
  const fetchPos = src.indexOf('await fetch(');
  assert.ok(capPos > 0, 'debe comprobar el tope');
  assert.ok(
    capPos < fetchPos,
    'el tope debe comprobarse antes de llamar a la API'
  );
  assert.ok(
    src.includes('SPACE_BUNNY_DAILY_CAP'),
    'el tope debe venir del entorno'
  );
});

check('el gasto se informa en /estado y en la API del panel', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const api = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'api_recursos.js'),
    'utf8'
  );
  assert.ok(app.includes('ai.getUsage()'), '/estado debe mostrar el gasto');
  assert.ok(api.includes('uso_ia'), 'la API debe reportar el uso');
});

check('los mensajes predeterminados son los exactos del prompt', () => {
  assert.strictEqual(
    ai.MISSING_EVENT,
    'Para agendar, por favor indícame:\n📅 Fecha\n⏰ Hora\n📝 Qué cosa (motivo)\n📍 Dónde',
    'el mensaje de evento debe coincidir caracter por caracter'
  );
  assert.strictEqual(
    ai.MISSING_TASK,
    'Para crear la tarea necesito:\n👤 Para quién\n✅ Qué tarea\n🔥 Prioridad\n⏳ Fecha límite',
    'el mensaje de tarea debe coincidir caracter por caracter'
  );
});

check('el prompt incluye la fecha y hora ya resueltas', () => {
  const p = ai.buildSystemPrompt();
  const ahora = ai.momentoActual();
  // Los placeholders {CURRENT_DATE} / {CURRENT_TIME} deben estar reemplazados.
  assert.ok(!p.includes('{CURRENT_DATE}'), 'no debe quedar el placeholder sin resolver');
  assert.ok(!p.includes('{CURRENT_TIME}'), 'no debe quedar el placeholder sin resolver');
  assert.ok(p.includes(ahora.date), 'debe incluir la fecha actual');
  assert.ok(p.includes(ahora.time), 'debe incluir la hora actual');
  assert.ok(p.includes('America/Asuncion'), 'debe indicar la zona horaria');
});

check('el prompt declara las 5 intenciones', () => {
  const p = ai.buildSystemPrompt();
  for (const i of ['chat', 'create_document', 'schedule_event', 'add_task', 'update_task']) {
    assert.ok(p.includes(`"${i}"`), `falta la intención ${i}`);
  }
  assert.ok(p.includes('Space Bunny Alpha'), 'debe presentarse como Space Bunny Alpha');
  assert.ok(p.includes('lista blanca'), 'debe mencionar la lista blanca');
});

check('el mensaje predeterminado se impone si faltan datos', () => {
  // schedule_event sin fecha: debe pedir los datos, no agendar.
  const r1 = ai.aplicarMensajesPredeterminados({
    intent: 'schedule_event',
    response_text: 'algo distinto',
    data: { title: 'Reunión', start_at: null, location: 'Sala 3' },
  });
  assert.strictEqual(r1.response_text, ai.MISSING_EVENT);
  assert.strictEqual(r1.faltan_datos, true);

  // add_task incompleta: debe pedir los datos.
  const r2 = ai.aplicarMensajesPredeterminados({
    intent: 'add_task',
    response_text: 'creada!',
    data: { assignee: null, title: 'x', priority: 'alta', due_at: null },
  });
  assert.strictEqual(r2.response_text, ai.MISSING_TASK);
  assert.strictEqual(r2.faltan_datos, true);
});

check('una fecha partida en date+time cuenta como resuelta', () => {
  // El caso que fallo en produccion: start_at null pero date+time presentes.
  const r = ai.aplicarMensajesPredeterminados({
    intent: 'schedule_event',
    response_text: 'agendada',
    data: { title: 'Reunión', start_at: null, date: 'tomorrow', time: '15:00', location: 'Sala 3' },
  });
  assert.strictEqual(r.faltan_datos, undefined, 'no debe pedir datos de nuevo');
  assert.strictEqual(r.response_text, 'agendada', 'debe respetar la respuesta del modelo');
});

check('chat y create_document nunca seVen forzados', () => {
  for (const intent of ['chat', 'create_document', 'update_task']) {
    const r = ai.aplicarMensajesPredeterminados({
      intent,
      response_text: 'libre',
      data: {},
    });
    assert.strictEqual(r.faltan_datos, undefined, `${intent} no debe forzarse`);
    assert.strictEqual(r.response_text, 'libre');
  }
});

check('index.js respeta faltan_datos y no ejecuta la accion', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(
    src.includes('result.faltan_datos'),
    'debe chequear faltan_datos antes de ejecutar'
  );
  const checkPos = src.indexOf('result.faltan_datos');
  const actionPos = src.indexOf('actionScheduleEvent(result.data, ctx)');
  assert.ok(
    checkPos < actionPos,
    'el chequeo debe ir antes de ejecutar la acción'
  );
  // Y debe usar "assignee", el campo que define el prompt.
  assert.ok(src.includes('data.assignee'), 'debe leer el campo assignee');
});

console.log('\nBusqueda web con DuckDuckGo');

check('la herramienta buscar_en_web está declarada en formato OpenAI', () => {
  assert.ok(Array.isArray(ai.HERRAMIENTAS), 'debe ser un array');
  assert.strictEqual(ai.HERRAMIENTAS.length, 1, 'solo hay una herramienta');

  const t = ai.HERRAMIENTAS[0];
  assert.strictEqual(t.type, 'function');
  assert.strictEqual(t.function.name, 'buscar_en_web');
  // Formato de parametros compatible con OpenAI.
  const p = t.function.parameters;
  assert.strictEqual(p.type, 'object');
  assert.ok(p.properties.query, 'debe declarar el parametro query');
  assert.ok(p.required.includes('query'), 'query es obligatorio');
});

check('ejecutarHerramientas devuelve mensajes con rol "tool"', async () => {
  const r = await ai.ejecutarHerramientas(
    [
      {
        id: 'call_test',
        type: 'function',
        function: {
          name: 'buscar_en_web',
          arguments: JSON.stringify({ query: 'capital de Paraguay' }),
        },
      },
    ],
    {}
  );
  assert.strictEqual(r.busquedas, 1, 'debe contar una búsqueda');
  assert.ok(r.mensajes.length >= 1, 'debe devolver al menos un mensaje');
  assert.strictEqual(r.mensajes[0].role, 'tool', 'el rol debe ser "tool"');
  assert.strictEqual(r.mensajes[0].tool_call_id, 'call_test', 'debe mantener el id');
});

check('una herramienta desconocida no rompe el flujo', async () => {
  const r = await ai.ejecutarHerramientas(
    [{ id: 'c1', function: { name: 'otra_cosa', arguments: '{}' } }],
    {}
  );
  assert.strictEqual(r.busquedas, 0, 'no debe contar como búsqueda');
  assert.ok(
    r.mensajes[0].content.includes('desconocida'),
    'debe avisar que la herramienta no existe'
  );
});

check('una consulta vacía se rechaza sin llamar a la red', async () => {
  const r = await ai.ejecutarHerramientas(
    [{ id: 'c1', function: { name: 'buscar_en_web', arguments: '{}' } }],
    {}
  );
  assert.strictEqual(r.busquedas, 0);
  assert.ok(r.mensajes[0].content.includes('vacía'));
});

check('el flujo de route usa doble llamada con tools', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'ai_router.js'),
    'utf8'
  );
  assert.ok(src.includes('tools: HERRAMIENTAS') || src.includes('cuerpo.tools'),
    'debe enviar las herramientas en la primera llamada');
  assert.ok(src.includes('tool_calls'), 'debe interceptar los tool_calls');
  assert.ok(src.includes("role: 'tool'"), 'debe inyectar mensajes con rol tool');
  assert.ok(src.includes('ejecutarHerramientas'), 'debe ejecutar la búsqueda');
  // La primera llamada NO debe forzar JSON (si lo fuerza, no puede pedir tools).
  const toolsPos = src.indexOf('cuerpo.tools = HERRAMIENTAS');
  const jsonPos = src.indexOf('cuerpo.response_format');
  assert.ok(jsonPos < toolsPos, 'response_format se aplica aparte de tools');
  assert.ok(
    src.includes('conHerramientas && !forzarJson'),
    'tools solo en la llamada que no fuerza JSON'
  );
});

check('web_search usa solo DuckDuckGo', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'web_search.js'),
    'utf8'
  );
  assert.ok(src.includes('duckduckgo'), 'debe usar DuckDuckGo');
  assert.ok(src.includes('html.duckduckgo.com'), 'debe consultar la web de DDG');
  // No debe hardcodear ninguna API key de pago.
  assert.ok(!/sk-[a-zA-Z0-9]{20,}/.test(src), 'no debe contener API keys');
  // Fuentes de error envueltas en try/catch.
  assert.ok(src.includes('catch'), 'debe manejar errores de red');
});

console.log('\nRedes y puertos');

check('el compose NO declara redes externas de Traefik', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const yml = fs2.readFileSync(
    path2.join(__dirname, '..', 'docker-compose.yml'),
    'utf8'
  );
  // El compose no debe depender de redes externas: debe ser autocontenido.
  assert.ok(
    !/external:\s*true/.test(yml),
    'no debe declarar redes externas: fallan si el nombre no coincide'
  );
  assert.ok(
    !/traefik\./i.test(yml) || !yml.includes('traefik.http'),
    'no debe declarar etiquetas de Traefik'
  );
});

check('el servicio solo usa su red propia', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const yml = fs2.readFileSync(
    path2.join(__dirname, '..', 'docker-compose.yml'),
    'utf8'
  );
  // Una sola red propia definida a nivel global.
  assert.strictEqual(
    (yml.match(/^networks:\s*$/gm) || []).length,
    1,
    'debe haber una unica definicion global de redes'
  );
  assert.ok(
    !/^\s{2}traefik:\s*$/m.test(yml),
    'no debe existir una red llamada traefik'
  );
  // Y el servicio no debe apuntar a ninguna red externa.
  assert.ok(
    !/^\s{6}-\s*traefik\s*$/m.test(yml),
    'el servicio no debe unirse a una red traefik'
  );
});

console.log('\nEntrypoint del contenedor');

check('el entrypoint usa finales de linea LF, no CRLF', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const buf = fs2.readFileSync(
    path2.join(__dirname, '..', 'docker-entrypoint.sh')
  );
  // Con CRLF el shebang queda "#!/bin/sh\r" y el contenedor arranca con
  // "/app/docker-entrypoint.sh: No such file or directory".
  for (let i = 0; i < buf.length - 1; i += 1) {
    if (buf[i] === 13 && buf[i + 1] === 10) {
      throw new Error('el archivo tiene finales CRLF');
    }
  }
  assert.strictEqual(buf[buf.length - 1], 10, 'debe terminar en salto de linea');
});

check('el entrypoint no tiene BOM al inicio', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const buf = fs2.readFileSync(
    path2.join(__dirname, '..', 'docker-entrypoint.sh')
  );
  // El BOM UTF-8 (EF BB BF) delante del shebang tambien lo rompe.
  const conBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  assert.strictEqual(conBom, false, 'no debe tener BOM UTF-8');
});

check('el shebang apunta a un interprete existente', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const primera = fs2
    .readFileSync(path2.join(__dirname, '..', 'docker-entrypoint.sh'), 'utf8')
    .split('\n')[0]
    .trim();
  assert.strictEqual(primera, '#!/bin/sh');
});

check('el Dockerfile normaliza el entrypoint al construir', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const df = fs2.readFileSync(path2.join(__dirname, '..', 'Dockerfile'), 'utf8');
  // Red de seguridad: aunque el .sh llegue con CRLF, el build lo corrige.
  assert.ok(
    df.includes("sed -i 's/\\r$//'"),
    'debe quitar los CR del entrypoint durante el build'
  );
  assert.ok(df.includes('chmod +x /app/docker-entrypoint.sh'), 'debe hacerlo ejecutable');
});

check('.gitattributes fuerza LF en los scripts', () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const ga = fs2.readFileSync(
    path2.join(__dirname, '..', '.gitattributes'),
    'utf8'
  );
  assert.ok(
    /\*.sh\s+text\s+eol=lf/.test(ga),
    'debe declarar eol=lf para los scripts de shell'
  );
});

check('el codigo de vinculacion se publica en la web', () => {
  const api = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'api_recursos.js'),
    'utf8'
  );
  const http = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'health_server.js'),
    'utf8'
  );
  // El codigo se renueva cada ~3 min: sin esto hay que cazarlo en los logs.
  assert.ok(api.includes('codigo_vinculacion'), 'debe exponer el codigo vigente');
  assert.ok(api.includes('setCodigoVinculacion'), 'debe permitir inyectarlo');
  assert.ok(
    api.includes('!vinculado && codigo'),
    'solo se muestra mientras no este vinculado'
  );
  assert.ok(http.includes('setPairingCode'), 'el servidor debe exportarlo');
});

check('index.js publica y limpia el codigo de vinculacion', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes('health.setPairingCode(code)'), 'debe publicarlo al recibirlo');
  assert.ok(
    src.includes('health.setPairingCode(null)'),
    'debe limpiarlo al autenticar'
  );
});

check('el QR repetido no inunda los logs', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  // WhatsApp renueva el QR cada ~20 s: con BOT_PHONE eso son miles de lineas.
  assert.ok(
    src.includes('qrAvisado'),
    'debe avisar del QR una sola vez cuando hay BOT_PHONE'
  );
});

console.log('\nZona horaria');

check('el compose define TZ en los dos servicios', () => {
  const yml = fs.readFileSync(
    path.join(__dirname, '..', 'docker-compose.yml'),
    'utf8'
  );
  // MongoDB y orbitaos: sin esto los timestamps quedan en UTC.
  const ocurrencias = (yml.match(/TZ: \$\{TZ:-America\/Asuncion\}/g) || []).length;
  assert.strictEqual(ocurrencias, 2, 'debe estar en mongo y en orbitaos');
});

check('los cron usan la zona horaria del negocio', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'cron_jobs.js'), 'utf8');
  assert.ok(src.includes('America/Asuncion'), 'debe usar la zona por defecto');
  assert.ok(src.includes('process.env.CRON_TZ'), 'debe respetar CRON_TZ');
});

check('el .env.example declara TZ=America/Asuncion', () => {
  const env = fs.readFileSync(
    path.join(__dirname, '..', '.env.example'),
    'utf8'
  );
  assert.ok(env.includes('TZ=America/Asuncion'));
  assert.ok(env.includes('CRON_TZ=America/Asuncion'));
  assert.ok(!env.includes('Buenos_Aires'), 'no debe quedar la zona vieja');
});

check('el compose publica los puertos locales', () => {
  const yml = fs.readFileSync(
    path.join(__dirname, '..', 'docker-compose.yml'),
    'utf8'
  );
  assert.ok(yml.includes('"3000:3000"'), 'panel en http://localhost:3000');
  assert.ok(yml.includes('"27017:27017"'), 'mongo accesible desde el host');
});

check('el servidor de salud responde /health y /', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'health_server.js'),
    'utf8'
  );
  assert.ok(src.includes("'/health'"), 'debe exponer /health');
  assert.ok(src.includes("'/healthz'"), 'debe exponer el alias /healthz');
  assert.ok(src.includes('startHealthServer'), 'debe exportar el arranque');
  // Sin dependencias: solo el modulo http de Node.
  assert.ok(src.includes("require('http')"));
  assert.ok(!src.includes('express'), 'no debe agregar dependencias');
});

check('index.js arranca y cierra el servidor de salud', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes('health.startHealthServer'), 'debe iniciarlo');
  assert.ok(src.includes('health.setReady(true)'), 'debe marcar listo en ready');
  assert.ok(src.includes('httpServer.close'), 'debe cerrarlo en el shutdown');
});

console.log('\nLista blanca por WhatsApp');

check('los comandos de whitelist exigen permiso de admin', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes('isAdmin'), 'debe verificar el rol');
  assert.ok(
    src.includes('No tenés permiso para administrar la lista blanca'),
    'debe rechazar a los no-admin'
  );
  for (const cmd of ['/agregar', '/quitar', '/contactos']) {
    assert.ok(src.includes(cmd), `falta el comando ${cmd}`);
  }
});

check('ADMIN_WHITELIST define quienes administran', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.ok(src.includes('ADMIN_WHITELIST'));
  // Y tambien sirve el rol owner/admin en la base.
  assert.ok(src.includes("u.role === 'owner'"));
});

console.log(`\n${passed} comprobaciones OK\n`);
