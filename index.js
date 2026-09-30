'use strict';
// OrbitaOs - punto de entrada.

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

const db = require('./src/database');
const ai = require('./src/ai_router');
const cron = require('./src/cron_jobs');
const programados = require('./src/scheduled_messages');
const users = require('./src/users');
const health = require('./src/health_server');
const taskFlow = require('./src/task_flow');

const { User, Message, Event, Task } = db;

const LOG_MESSAGES = (process.env.LOG_MESSAGES || 'true') === 'true';

// La fuente de verdad es la coleccion User: cualquier usuario con telefono y allowed=true puede hablar con el bot.

/** Normaliza un numero de WhatsApp a solo digitos, sin el @c.us ni el pais agregado. */
function normalizePhone(id) {
  return String(id).split('@')[0].replace(/\D/g, '');
}

// Indica si el remitente esta autorizado, consultando la base de datos.
async function isAllowed(senderId) {
  return users.isAllowedPhone(normalizePhone(senderId));
}

/** Numeros de la variable WHITELIST (respaldo / carga inicial). */
function envWhitelist() {
  return (process.env.WHITELIST || '')
    .split(',')
    .map((p) => p.replace(/\D/g, ''))
    .filter(Boolean);
}

/* =========================================================================
 * Cliente de WhatsApp
 * ====================================================================== */

const sessionPath = process.env.SESSION_PATH || path.join(__dirname, 'session');
fs.mkdirSync(sessionPath, { recursive: true });

// Telefono del numero corporativo, solo digitos con prefijo del pais.
const BOT_PHONE = (process.env.BOT_PHONE || '').replace(/\D/g, '');

// Navegador: CHROME_PATH, Chromium del sistema o el de Puppeteer.
const chromePath =
  process.env.CHROME_PATH ||
  (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined) ||
  [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((p) => fs.existsSync(p));

/** Ultimo codigo de emparejamiento emitido, para el diagnostico HTTP. */
let ultimoCodigo = null;

/** Cuantos codigos se emitieron sin completar la vinculacion. */
let codigosEmitidos = 0;

// Elimina los locks de Chromium de una ejecucion anterior.
function clearChromiumLocks() {
  // LocalAuth compone el directorio asi: dataPath + "session-" + clientId.
  const profileDir = path.join(sessionPath, 'session-orbitaos');

  let entradas = [];
  try {
    if (!fs.existsSync(profileDir)) {
      console.log(`[wa] perfil nuevo en ${profileDir}`);
      return { profileDir, borrados: 0 };
    }
    entradas = fs.readdirSync(profileDir);
  } catch (err) {
    console.warn(`[wa] no se pudo leer el perfil: ${err.message}`);
    return { profileDir, borrados: 0 };
  }

  // Los locks de Chromium siempre empiezan por "Singleton".
  const locks = entradas.filter((e) => e.startsWith('Singleton'));
  const resumen = entradas.slice(0, 10).join(', ') || '(vacio)';
  console.log(`[wa] perfil ${profileDir}: ${entradas.length} entradas -> ${resumen}`);

  if (!locks.length) return { profileDir, borrados: 0 };

  let borrados = 0;
  for (const lock of locks) {
    try {
      // unlink borra el symlink aunque su destino ya no exista.
      fs.unlinkSync(path.join(profileDir, lock));
      borrados += 1;
    } catch (err) {
      console.warn(`[wa] no se pudo borrar ${lock} (${err.code}): ${err.message}`);
    }
  }

  if (borrados) {
    console.log(`[wa] ${borrados} lock(s) eliminado(s): ${locks.join(', ')}`);
  }
  return { profileDir, borrados };
}

// Destruye por completo el perfil de Chromium.
function wipeChromiumProfile(profileDir) {
  const dir = profileDir || path.join(sessionPath, 'session-orbitaos');
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[wa] perfil de Chromium reconstruido: ${dir}`);
    console.log('[wa] habra que volver a vincular WhatsApp con el codigo de 8 caracteres.');
    return true;
  } catch (err) {
    console.error(`[wa] no se pudo reconstruir el perfil (${err.code}): ${err.message}`);
    console.error('[wa] Borra la sesion: npm run reset:session -- --force.');
    return false;
  }
}

const perfil = clearChromiumLocks();
console.log(
  `[wa] sesion: ruta=${sessionPath} perfil=${perfil.profileDir} locks=${perfil.borrados}`
);

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: sessionPath,
    clientId: 'orbitaos',
  }),
  puppeteer: {
    // 'new' en vez de 'true': con las versiones nuevas de Chromium, 'true'
    // queda deprecado y puede arrancar en modo con display, provocando el
    // error "Can't open display:" dentro del contenedor.
    headless: process.env.PUPPETEER_HEADLESS === 'false' ? false : 'new',
    // Sin ruta resuelta, Puppeteer usa el navegador que descargó al instalar.
    executablePath: chromePath,
    args: [
      // Imprescindible en contenedores: sin esto Chromium no arranca como root.
      '--no-sandbox',
      '--disable-setuid-sandbox',
      // El /dev/shm por defecto son 64MB y Chromium se cae por falta de memoria.
      // El compose ya define shm_size: 1gb; esto es la red de seguridad.
      '--disable-dev-shm-usage',
      '--disable-gpu',
      // Reforza el modo headless y evita que intente abrir un display.
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--no-first-run',
      '--no-zygote',
      '--ignore-certificate-errors',
    ],
  },
});

/* =========================================================================
 * Utilidades de formato
 * ====================================================================== */

function formatDate(date, timezone) {
  try {
    return new Intl.DateTimeFormat('es-AR', {
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone || 'America/Asuncion',
    }).format(date);
  } catch (_) {
    return date.toISOString();
  }
}

/** Convierte una fecha ISO o Date en Date, o null si no es valida. */
function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* =========================================================================
 * Persistencia
 * ====================================================================== */

// Registra un mensaje en la bitacora.
async function persistMessage({ chatId, from, to, direction, body, intent, data, fallback, isGroup, whatsappMessageId }) {
  try {
    return await Message.create({
      chatId,
      from,
      to,
      direction,
      body,
      intent: intent || null,
      data: data || null,
      fallback: Boolean(fallback),
      isGroup: Boolean(isGroup),
      whatsappMessageId: whatsappMessageId || null,
    });
  } catch (err) {
    console.error(`[db] no se pudo guardar el mensaje: ${err.message}`);
    return null;
  }
}

// Carga los ultimos mensajes del chat para darselo como contexto a la IA.
async function getHistory(chatId) {
  try {
    const docs = await Message.find({ chatId })
      .sort({ createdAt: -1 })
      .limit(Number(process.env.AI_CONTEXT_MESSAGES || 8))
      .lean();

    // De mas reciente a mas antiguo: se invierte para el formato de la API.
    return docs
      .reverse()
      .map((m) => ({
        role: m.direction === 'outbound' ? 'assistant' : 'user',
        content: m.body,
      }));
  } catch (err) {
    console.error(`[db] no se pudo leer el historial: ${err.message}`);
    return [];
  }
}

/** Devuelve el usuario, creandolo la primera vez. */
async function getOrCreateUser(phone) {
  const clean = normalizePhone(phone);
  let user = await User.findOne({ phone: clean }).lean();
  if (!user) {
    try {
      user = await User.create({
        username: `wa${clean}`,
        passwordHash: 'sin-acceso-por-whatsapp',
        phone: clean,
        name: '',
        allowed: true,
      });
      user = user.toObject();
    } catch (err) {
      console.error(`[db] no se pudo crear el usuario: ${err.message}`);
      user = { phone: clean, timezone: 'America/Asuncion', name: '' };
    }
  }
  User.updateOne({ phone: clean }, { $set: { lastSeenAt: new Date() } }).catch(() => {});
  return user;
}

/* =========================================================================
 * Acciones por intencion
 * ====================================================================== */

/** Crea un evento a partir de los datos de la IA. */
async function actionScheduleEvent(data, ctx) {
  const startAt = ai.resolveEventDate(data);
  if (!startAt) {
    return 'Necesito una fecha y hora concretas para agendar la cita. Usá el formato "el 12/09 a las 15:00" o "mañana a las 10:00".';
  }

  const duration = Number(data.duration_minutes || data.durationMinutes || 60);
  const endAt = data.end_at ? toDate(data.end_at) : new Date(startAt.getTime() + duration * 60000);

  const event = await Event.create({
    title: data.title || 'Cita',
    description: data.description || '',
    owner: ctx.owner,
    createdBy: ctx.from,
    chatId: ctx.chatId,
    startAt,
    endAt,
    location: data.location || '',
    status: 'confirmed',
  });

  const lines = [
    '✅ *Cita agendada*',
    '',
    `*${event.title}*`,
    `🗓 ${formatDate(event.startAt, ctx.timezone)}`,
    `⏳ Fin estimado: ${formatDate(event.endAt, ctx.timezone)}`,
  ];
  if (event.location) lines.push(`📍 ${event.location}`);
  lines.push('', 'Te aviso 24 horas y 2 horas antes.');
  return lines.join('\n');
}

/** Crea una tarea en el pipeline. */
async function actionAddTask(data, ctx) {
  const title = (data.title || '').trim();
  if (!title) return 'La tarea necesita un titulo. Decime que hay que hacer.';

  // Position al final de la columna para mantener el orden del tablero.
  const last = await Task.findOne({ owner: ctx.owner, status: data.status || 'todo' })
    .sort({ position: -1 })
    .lean();

  const task = await Task.create({
    title,
    description: data.description || '',
    owner: ctx.owner,
    createdBy: ctx.from,
    chatId: ctx.chatId,
    status: data.status || 'todo',
    priority: data.priority || 'medium',
    dueAt: toDate(data.due_at),
    position: (last && last.position ? last.position : 0) + 1,
    // El prompt usa "assignee" para indicar a quien se asigna: va como etiqueta.
    labels: data.assignee
      ? [String(data.assignee).toLowerCase()]
      : Array.isArray(data.labels)
        ? data.labels
        : [],
  });

  const partes = [
    '✅ *Tarea creada*',
    '',
    `*${task.title}*`,
    `🔁 Estado: ${task.status}`,
    `🚦 Prioridad: ${task.priority}`,
  ];
  if (task.dueAt) partes.push(`📅 Vence: ${formatDate(task.dueAt, ctx.timezone)}`);
  if (data.assignee) partes.push(`👤 Para: ${data.assignee}`);
  return partes.join('\n');
}

/** Actualiza una tarea existente del pipeline. */
async function actionUpdateTask(data, ctx) {
  const patch = {};
  if (data.title) patch.title = data.title;
  if (data.description) patch.description = data.description;
  if (data.status) patch.status = data.status;
  if (data.priority) patch.priority = data.priority;
  if (data.due_at) patch.dueAt = toDate(data.due_at);

  // El prompt define "assignee" como a quien se asigna. Se usa como etiqueta.
  if (data.assignee) patch.labels = [String(data.assignee).toLowerCase()];

  if (Object.keys(patch).length === 0) {
    return 'No recibi ningun cambio que aplicar. Indicame que tarea y que modificar.';
  }

  // Con task_id apunta a una en concreto; sin el, opera sobre la mas reciente.
  const filter = data.task_id
    ? { _id: data.task_id, owner: ctx.owner }
    : { owner: ctx.owner };

  const updated = await Task.findOneAndUpdate(filter, { $set: patch }, { new: true });

  if (!updated) return 'No encontre esa tarea en tu pipeline.';
  return `✅ *Tarea actualizada*\n\n*${updated.title}*\n🔁 Estado: ${updated.status}\n🚦 Prioridad: ${updated.priority}`;
}

/** Genera un documento en Markdown y responde con su contenido. */
async function actionCreateDocument(data, ctx) {
  const title = (data.title || 'Documento').trim();
  const content = (data.content || '').trim() || `_Sin contenido adicional._\n\n_${title}_`;

  const doc = [
    `# ${title}`,
    '',
    `> Generado por OrbitaOs · ${formatDate(new Date(), ctx.timezone)}`,
    '',
    content,
  ].join('\n');

  await persistMessage({
    chatId: ctx.chatId,
    from: 'orbitaos',
    to: ctx.owner,
    direction: 'outbound',
    body: `[documento] ${title}`,
    intent: 'create_document',
    data: { title, type: data.type || 'document' },
  });

  return `📄 *${title}*\n\n${doc}`;
}

/* =========================================================================
 * Comandos directos (no pasan por la IA)
 * ====================================================================== */

const HELP_TEXT = [
  '🤖 *OrbitaOs* — tu asistente de operaciones',
  '',
  'Puedo hacer esto:',
  '• 📅 Agendar citas y reuniones',
  '• 📄 Redactar documentos e informes',
  '• ✅ Crear y actualizar tareas del pipeline',
  '• 💬 Charlar y pedirme cosas',
  '',
  '*Ejemplos*',
  '"Agenda una reunion con el equipo el 12/09 a las 15:00"',
  '"Crear una tarea urgente: llamar al proveedor antes del viernes"',
  '"Redacta un acta de la reunion de ayer"',
  '"Completar la tarea de llamar al proveedor"',
  '',
  '*Comandos*',
  '/help — esta ayuda',
  '/agenda — tus proximas citas',
  '/tareas — el estado de tu pipeline',
  '/tarea — dar de alta una tarea paso a paso (sin gastar IA)',
  '/estado — diagnostico del sistema',
  '/contactos — la lista blanca',
  '/agregar <numero> <nombre> — autoriza a alguien',
  '/quitar <numero> — revoca el acceso',
].join('\n');

/** Lista los proximos eventos del usuario. */
async function commandAgenda(owner) {
  const events = await Event.find({
    owner,
    status: 'confirmed',
    startAt: { $gte: new Date() },
  })
    .sort({ startAt: 1 })
    .limit(10)
    .lean();

  if (!events.length) return '📅 No tenes citas programadas.';

  const lines = ['📅 *Tus proximas citas*', ''];
  for (const e of events) {
    lines.push(`• *${e.title}*`);
    lines.push(`  🗓 ${formatDate(e.startAt)}`);
    if (e.location) lines.push(`  📍 ${e.location}`);
  }
  return lines.join('\n');
}

/** Lista las tareas agrupadas por columna del Kanban. */
async function commandTasks(owner) {
  const tasks = await Task.find({ owner, status: { $ne: 'done' } })
    .sort({ position: 1 })
    .lean();

  if (!tasks.length) return '✅ No tenes tareas pendientes.';

  const columns = {
    backlog: '🗂 Backlog',
    todo: '📌 Por hacer',
    in_progress: '⚙️ En progreso',
    review: '👀 En revision',
  };

  const lines = ['✅ *Tu pipeline*', ''];
  for (const [key, label] of Object.entries(columns)) {
    const group = tasks.filter((t) => t.status === key);
    if (!group.length) continue;
    lines.push(`*${label}*`);
    for (const t of group) {
      const due = t.dueAt ? ` (vence ${formatDate(t.dueAt)})` : '';
      lines.push(`• ${t.title} — ${t.priority}${due}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

/** Diagnostico del sistema. */
async function commandStatus() {
  const [totalUsers, allowedCount, messages, events, tasks] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ allowed: true }),
    Message.countDocuments(),
    Event.countDocuments(),
    Task.countDocuments(),
  ]);
  const mode = process.env.SPACE_BUNNY_API_KEY
    ? 'Space Bunny Alpha'
    : 'MODO MOCK (sin IA)';
  const uso = ai.getUsage();
  return [
    '🛰 *Estado de OrbitaOs*',
    '',
    `• IA: ${mode}`,
    `• Usuarios: ${totalUsers} (${allowedCount} con acceso)`,
    `• Mensajes: ${messages}`,
    `• Eventos: ${events}`,
    `• Tareas: ${tasks}`,
    `• Cron: ${process.env.CRON_REMINDERS || '*/1 * * * *'}`,
    '',
    `💰 *Gasto de hoy*`,
    `• Llamadas: ${uso.llamadas}${uso.tope_diario ? ` de ${uso.tope_diario} (tope)` : ''}`,
    `• Tokens: ${uso.tokens_total} (${uso.tokens_prompt} entrada + ${uso.tokens_completion} salida)`,
    `• Errores: ${uso.errores}`,
  ].join('\n');
}

// Solo los usuarios con rol owner o admin pueden agregar o quitar contactos.

/** Indica si el usuario puede administrar la lista blanca. */
function isAdmin(phone) {
  const ADMIN_PHONES = (process.env.ADMIN_WHITELIST || '')
    .split(',')
    .map((p) => p.replace(/\D/g, ''))
    .filter(Boolean);
  if (ADMIN_PHONES.includes(normalizePhone(phone))) return true;

  // Tambien si el usuario esta marcado como owner o admin en la base.
  return db
    .User.findOne({ phone: normalizePhone(phone) })
    .lean()
    .then((u) => Boolean(u && (u.role === 'owner' || u.role === 'admin')))
    .catch(() => false);
}

/** Comando /agregar <numero> [nombre] */
async function commandAddContact(args, fromPhone) {
  const [rawPhone, ...rest] = args;
  const phone = normalizePhone(rawPhone || '');

  if (phone.length < 8) {
    return 'Uso: /agregar <numero> [nombre]\nEj: /agregar 5491198765432 Ana';
  }

  const name = rest.join(' ').trim();
  const existe = await User.findOne({ phone }).lean();

  if (existe) {
    await User.updateOne({ phone }, { $set: { allowed: true, ...(name ? { name } : {}) } });
    return `✅ *${phone}* ya estaba en la lista. Acceso reactivado.`;
  }

  await User.create({
    username: `wa${phone}`,
    passwordHash: 'sin-acceso-por-whatsapp',
    phone,
    name,
    role: 'member',
    allowed: true,
  });

  return `✅ *Contacto agregado*\n\n📱 ${phone}${name ? `\n👤 ${name}` : ''}\n\nYa puede escribir al bot.`;
}

/** Comando /quitar <numero> */
async function commandRemoveContact(args) {
  const phone = normalizePhone(args[0] || '');
  if (phone.length < 8) return 'Uso: /quitar <numero>\nEj: /quitar 5491198765432';

  const r = await User.deleteOne({ phone });
  if (!r.deletedCount) return `No hay ningun contacto con ${phone}.`;
  return `🗑 *${phone}* eliminado de la lista blanca. Ya no puede escribir al bot.`;
}

/** Comando /contactos — lista la lista blanca. */
async function commandListContacts() {
  const lista = await User.find({ phone: { $ne: null } }).sort({ createdAt: -1 }).lean();
  if (!lista.length) {
    return '📋 *Lista blanca vacía*\n\nAgregá el primero con:\n/agregar <numero> <nombre>';
  }

  const lines = [`📋 *Lista blanca* (${lista.length})`, ''];
  for (const u of lista.slice(0, 30)) {
    const marca = u.allowed ? '✅' : '⛔';
    lines.push(`${marca} ${u.phone}${u.name ? ` — ${u.name}` : ''}`);
  }
  if (lista.length > 30) lines.push(`\n_y ${lista.length - 30} más…_`);

  lines.push('', '_Agregar: /agregar <numero> <nombre>_', '_Quitar: /quitar <numero>_');
  return lines.join('\n');
}

/* =========================================================================
 * Orquestacion de mensajes
 * ====================================================================== */

// Procesa un mensaje entrante: valida, persiste, enruta a la IA y responde.
async function handleMessage(msg) {
  const isGroup = Boolean(msg.from.endsWith('@g.us'));
  const chatId = normalizePhone(msg.from);
  const body = (msg.body || '').trim();

  if (!body) return;
  // Ignora estados (read, delivered) y mensajes de sistema.
  if (!isGroup && msg.type !== 'chat') return;

  // --- Lista blanca: nadie mas es atendido ---
  if (!(await isAllowed(msg.from))) {
    console.log(`[whitelist] mensaje ignorado de ${msg.from}`);
    return;
  }

  // En grupos solo responde si lo invocan con el prefijo configurado.
  const prefix = process.env.GROUP_PREFIX || '';
  if (isGroup && (!prefix || !body.startsWith(prefix))) return;

  if (LOG_MESSAGES) console.log(`[wa] ${msg.from}: ${body}`);

  const user = await getOrCreateUser(msg.from);
  const cleanBody = isGroup ? body.slice(prefix.length).trim() : body;
  const ctx = { owner: chatId, from: chatId, chatId, timezone: user.timezone };

  // 1) Guardar el mensaje entrante.
  await persistMessage({
    chatId,
    from: chatId,
    to: 'orbitaos',
    direction: 'inbound',
    body: cleanBody,
    isGroup,
    whatsappMessageId: msg.id && msg.id._serialized,
  });

  // 2) Comandos directos.
  const lower = cleanBody.toLowerCase();
  let reply = null;

  // 2a) Gestion de la lista blanca, accesible desde el celular.
  //     Solo owner/admin; el resto recibe un rechazo.
  const partes = cleanBody.trim().split(/\s+/);
  const comando = partes[0] ? partes[0].toLowerCase() : '';
  const args = partes.slice(1);

  try {
    if (['/agregar', '/add', '/quitar', '/remove', '/contactos', '/lista'].includes(comando)) {
      if (!(await isAdmin(msg.from))) {
        reply = '⛔ No tenés permiso para administrar la lista blanca.';
      } else if (comando === '/agregar' || comando === '/add') {
        reply = await commandAddContact(args);
      } else if (comando === '/quitar' || comando === '/remove') {
        reply = await commandRemoveContact(args);
      } else {
        reply = await commandListContacts();
      }
    } else if (lower === '/help' || lower === 'ayuda') {
      reply = HELP_TEXT;
    } else if (lower === '/agenda') {
      reply = await commandAgenda(chatId);
    } else if (lower === '/tareas') {
      reply = await commandTasks(chatId);
    } else if (lower === '/estado') {
      reply = await commandStatus();
    }
  } catch (err) {
    console.error(`[cmd] fallo el comando: ${err.message}`);
    reply = 'Hubo un problema al ejecutar ese comando.';
  }

  // 2b) Flujo guiado de alta de tareas. Va ANTES de la IA a proposito:
  //     si el usuario esta completando el formulario, cada respuesta se
  //     resuelve con reglas locales y no se gasta un solo token. La IA solo
  //     entra si el mensaje no pertenece a un flujo en curso.
  if (!reply && taskFlow.estaActivo(chatId)) {
    try {
      const r = await taskFlow.procesar(chatId, cleanBody, ctx);
      reply = r.reply;
    } catch (err) {
      console.error(`[flow] fallo el flujo de tarea: ${err.message}`);
      taskFlow.cancelar(chatId);
      reply = 'Hubo un problema con el alta de la tarea. Volvé a empezar con `/tarea`.';
    }
  }

  // 2c) Pedir una tarea de forma explicita, sin pasar por la IA.
  if (!reply && taskFlow.detectarIntencion(cleanBody)) {
    const flujo = taskFlow.iniciar(chatId);
    reply = taskFlow.saludoInicial(flujo);
  }

  // 3) Sin comando: la IA decide la intencion.
  if (!reply) {
    try {
      const history = await getHistory(chatId);
      // Se descarta el ultimo inbound: ya viaja aparte en el prompt.
      const context = history.slice(0, -1);

      const result = await ai.route(cleanBody, {
        history: context,
        timezone: user.timezone,
        displayName: user.name,
      });

      // 4) Ejecutar la accion segun la intencion.
      //    Si faltan datos, el router ya fijo el mensaje predeterminado y no
      //    hay nada que ejecutar todavia: solo se le pide la informacion.
      if (result.faltan_datos) {
        reply = result.response_text;
        console.log(
          `[ai] ${result.intent}: faltan datos, se pide la informacion faltante`
        );
      } else {
        switch (result.intent) {
          case 'schedule_event':
            reply = await actionScheduleEvent(result.data, ctx);
            break;
          case 'add_task':
            reply = await actionAddTask(result.data, ctx);
            break;
          case 'update_task':
            reply = await actionUpdateTask(result.data, ctx);
            break;
          case 'create_document':
            reply = await actionCreateDocument(result.data, ctx);
            break;
          default:
            reply = result.response_text;
        }
      }

      // 5) Registrar la intencion detectada junto a la respuesta.
      await persistMessage({
        chatId,
        from: 'orbitaos',
        to: chatId,
        direction: 'outbound',
        body: reply,
        intent: result.intent,
        data: result.data,
        fallback: Boolean(result.mock || result.fallback_reason),
        isGroup,
      });
    } catch (err) {
      console.error(`[ai] fallo el procesamiento: ${err.message}`);
      reply = 'Hubo un problema procesando tu mensaje. Reintentá en un momento.';
    }
  }

  if (!reply) reply = 'No pude generar una respuesta. Probá reformularlo.';

  // 6) Enviar.
  try {
    await client.sendMessage(msg.from, reply);
  } catch (err) {
    console.error(`[wa] no se pudo enviar la respuesta: ${err.message}`);
  }
}


/* =========================================================================
 * Arranque y apagado
 * ====================================================================== */

let cronTask = null;
let tareaProgramados = null;
let httpServer = null;

/** Registra los eventos de ciclo de vida del cliente de WhatsApp. */
function registerClientEvents() {
  // --- Emparejamiento por CODIGO: lo unico util en un servidor sin monitor ---
  client.on('code', (code) => {
    ultimoCodigo = code;
    codigosEmitidos += 1;
    health.setPairingCode(code);
    console.log('\n' + '='.repeat(64));
    console.log('  CODIGO DE EMPAREJAMIENTO: ' + code);
    console.log('='.repeat(64));
    console.log('\n  En tu celular (WhatsApp > Dispositivos vinculados):');
    console.log('    1. Menú ≡  →  Dispositivos vinculados');
    console.log('    2. Entrá en "Vincular con número de teléfono"');
    console.log(`    3. Ingresá este código: ${code}`);
    console.log('\n  El código cambia cada pocos minutos.');
    console.log('  Usá SIEMPRE el ÚLTIMO que aparezca en los logs.');
    console.log(`  [actual: ${code}]`);
    console.log(`  [también en el panel: GET /  ->  "codigo_vinculacion"]\n`);

    // Si ya se emitieron muchos codigos sin autenticar, algo mas esta mal y
    // conviene decirlo en vez de seguir escupiendo codigos en silencio.
    if (codigosEmitidos === 5) {
      console.warn('[wa] Ya van 5 codigos sin vincular. Si al ingresarlos WhatsApp');
      console.warn('[wa] responde "no se pudo vincular", revisá:');
      console.warn(`[wa]   1. Que BOT_PHONE sea el número correcto (ahora: ${BOT_PHONE}),`);
      console.warn('[wa]      con prefijo de país y SIN + ni espacios. Ej: 595981123456');
      console.warn('[wa]   2. Que el código se ingrese dentro de los 3 minutos.');
      console.warn('[wa]   3. Que el volumen session-data no tenga una sesión vieja.');
    }
  });

  // --- Respaldo: QR por consola, para cuando no hay BOT_PHONE definido ---
  let qrAvisado = false;
  client.on('qr', (qr) => {
    if (BOT_PHONE) {
      // Con BOT_PHONE definido llega QR pero no se usa. WhatsApp lo renueva
      // cada ~20 s y llenaba los logs de ruido: se avisa una sola vez.
      if (!qrAvisado) {
        console.log('[wa] El navegador pidió un QR, pero BOT_PHONE está definido:');
        console.log('[wa] se usa el código de emparejamiento de arriba.');
        qrAvisado = true;
      }
      return;
    }
    console.log('\n[wa] Escanea este QR con WhatsApp > Dispositivos vinculados:');
    qrcode.generate(qr, { small: true }, (code) => console.log(code));
    console.log('\n[wa] Si no podés escanear el QR, definí BOT_PHONE en el entorno');
    console.log('[wa] para obtener un código de 8 caracteres en su lugar.\n');
  });

  client.on('authenticated', () => {
    console.log('[wa] Autenticado. Sesion vinculada.');
    // Ya no hace falta mostrarlo: se evita que quede un codigo viejo en la web.
    ultimoCodigo = null;
    codigosEmitidos = 0;
    health.setPairingCode(null);
  });
  client.on('ready', () => {
    console.log('[wa] OrbitaOs listo y escuchando mensajes.');
    health.setReady(true);
  });
  client.on('auth_failure', (msg) => {
    console.error(`[wa] Fallo de autenticacion: ${msg}`);
    console.error('[wa] El servicio reintenta solo. Para vincular de nuevo, usá el');
    console.error('[wa] ÚLTIMO código de emparejamiento que aparezca aquí abajo.');
  });
  client.on('disconnected', (reason) => {
    console.warn(`[wa] Desconectado: ${reason}`);
    health.setReady(false);
  });
  client.on('message', (msg) => {
    // Cada mensaje se procesa por separado; uno fallido no corta el flujo.
    handleMessage(msg).catch((err) => console.error(`[wa] error no capturado: ${err.message}`));
  });
}

/** Apagado ordenado: cierra el navegador y la base de datos. */
async function shutdown(signal) {
  console.log(`\n[app] recibido ${signal}, cerrando...`);
  cron.stopReminderJobs(cronTask);
  programados.stopScheduledJob(tareaProgramados);
  if (httpServer) {
    try {
      await new Promise((resolve) => httpServer.close(resolve));
    } catch (_) {
      /* el servidor puede estar caido */
    }
  }
  try {
    await client.destroy();
  } catch (_) {
    /* el navegador puede estar caido */
  }
  try {
    await db.disconnect();
  } catch (_) {
    /* la conexion puede estar caida */
  }
  process.exit(0);
}

/** Punto de entrada. */
async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('[app] falta la variable MONGO_URI');
    process.exit(1);
  }

  console.log('[app] conectando a MongoDB...');
  await db.connect(uri);

  // Servidor de salud. Arranca antes que WhatsApp para que el orquestador
  // vea el contenedor como vivo aun si el navegador tarda en vincularse.
  try {
    httpServer = await health.startHealthServer({ client });
  } catch (err) {
    console.error(`[http] no se pudo iniciar el servidor de salud: ${err.message}`);
  }

  // Primer arranque: crea el usuario owner si la base esta vacia.
  try {
    const boot = await users.ensureBootstrapUser();
    if (boot.created) {
      console.log(`[app] usuario owner creado: "${boot.username}"`);
      console.log('[app] defini ADMIN_USERNAME y ADMIN_PASSWORD para crearlo automaticamente.');
    }
  } catch (err) {
    // No se detiene el arranque: el bot puede seguir operando con la lista
    // blanca, y el usuario se puede crear despues con el script de gestion.
    console.error(`[app] no se pudo crear el usuario inicial: ${err.message}`);
  }

  // Telefonos de WHITELIST se dan de alta como usuarios con acceso, para
  // que la lista blanca viva en la base y no solo en el entorno.
  const envPhones = envWhitelist();
  for (const phone of envPhones) {
    const existe = await User.findOne({ phone }).lean();
    if (!existe) {
      try {
        await User.create({
          username: `wa${phone}`,
          passwordHash: 'sin-acceso-por-whatsapp',
          phone,
          name: '',
          allowed: true,
        });
        console.log(`[app] usuario de WhatsApp dado de alta: ${phone}`);
      } catch (err) {
        console.error(`[app] no se pudo dar de alta ${phone}: ${err.message}`);
      }
    }
  }

  const conAcceso = await User.countDocuments({ allowed: true });
  console.log(`[app] MongoDB conectado. Usuarios con acceso: ${conAcceso}`);
  if (conAcceso === 0 && envPhones.length === 0) {
    console.warn('[app] ATENCION: ningun usuario con acceso. El bot no respondera a nadie.');
    console.warn('[app] Crea uno con: npm run user -- create <usuario> <clave> --phone <numero>');
  }

  registerClientEvents();
  await initializeWithRecovery();

  // El cron solo arranca con WhatsApp listo: tanto los recordatorios como los
  // mensajes programados se envian por el mismo cliente.
  client.on('ready', () => {
    if (!cronTask) cronTask = cron.startReminderJobs(client);
    if (!tareaProgramados) tareaProgramados = programados.startScheduledJob(client);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => shutdown(signal));
  }

  process.on('unhandledRejection', (reason) => {
    console.error('[app] promesa rechazada sin manejar:', reason);
  });
}
// Arranca Chromium y, si falla por un perfil bloqueado o corrupto, lo destruye y reintenta una vez.
async function initializeWithRecovery() {
  // Si hay BOT_PHONE se pide emparejamiento con codigo, que es lo unico
  // util en un servidor sin monitor.
  const wantsPairing = Boolean(BOT_PHONE);

  for (let intento = 1; intento <= 2; intento += 1) {
    try {
      if (intento === 2) {
        console.log('[wa] segundo intento: se reconstruye el perfil de Chromium');
        wipeChromiumProfile();
      }
      if (wantsPairing) {
        console.log(`[app] emparejamiento por codigo para el numero ${BOT_PHONE}`);
      } else {
        console.log('[app] sin BOT_PHONE: empareja escaneando el QR de los logs.');
      }
      await client.initialize();

      // Navegador arriba: con BOT_PHONE se pide el codigo de emparejamiento
      // en vez de mostrar el QR, que en un servidor no se puede escanear.
      if (wantsPairing) {
        try {
          await client.requestPairingCode(BOT_PHONE);
        } catch (err) {
          console.error(`[wa] no se pudo pedir el codigo: ${err.message}`);
        }
      }
      return;
    } catch (err) {
      const detalle = err && err.message ? err.message : String(err);
      const esPerfil = /profile appears to be in use|SingletonLock|Code: 21|display/i.test(
        detalle
      );

      if (intento === 1 && esPerfil) {
        console.error(`[wa] el perfil de Chromium esta bloqueado: ${detalle.split('\n')[0]}`);
        console.error('[wa] se intentará de nuevo con el perfil limpio...');
        continue;
      }

      console.error(`[wa] fallo irrecuperable al iniciar el navegador: ${detalle}`);
      console.error('[wa] Si el error sigue siendo "profile in use": npm run reset:session -- --force');
      console.error('[wa] Borra la sesion y vuelve a vincular.');
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(`[app] error fatal: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});




