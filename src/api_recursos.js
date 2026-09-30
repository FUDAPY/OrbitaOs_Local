'use strict';
// OrbitaOs - manejadores de recursos de la API.

const crypto = require('crypto');
const db = require('./database');
const ai = require('./ai_router');
const usuarios = require('./users');
const sesion = require('./session');
const programados = require('./scheduled_messages');
const {
  responder,
  texto,
  telefono,
  telefonoValido,
  fecha,
  entero,
  opcion,
  hora,
  COLUMNAS,
  PRIORIDADES,
  ESTADOS_EVENTO,
  ROLES,
  MODOS,
} = require('./api_util');

/* =========================================================================
 * Helpers comunes
 * ====================================================================== */

/** Indica si la sesion pertenece a un administrador. */
function esAdmin(ctx) {
  return ctx.sesion.role === 'owner' || ctx.sesion.role === 'admin';
}

// Exige rol de administrador.
function exigirAdmin(ctx) {
  if (!esAdmin(ctx)) {
    throw new Error('Esta acción requiere rol de administrador');
  }
}

// Busca un documento por id, o lanza un error claro.
async function porId(Modelo, id, nombre) {
  const doc = await Modelo.findById(id).lean();
  if (!doc) throw new Error(`${nombre} no encontrado`);
  return doc;
}

/** Limite de la consulta, acotado para no traer la base entera. */
function limiteDe(valor, porDefecto = 100, max = 500) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1) return porDefecto;
  return Math.min(n, max);
}

/** Nombre para mostrar de un contacto: "Ana Gómez" o su telefono. */
function nombreDe(usuario) {
  const completo = [usuario.firstName, usuario.lastName].filter(Boolean).join(' ');
  return completo || usuario.name || usuario.phone || usuario.username;
}

/** Indica si un objeto trae una clave, aunque su valor sea vacio. */
function tiene(objeto, clave) {
  return Object.prototype.hasOwnProperty.call(objeto || {}, clave);
}

/** Escapa un texto para poder usarlo dentro de una expresion regular. */
function escaparRegex(textoOriginal) {
  return textoOriginal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Inicio del dia (00:00 local) de una fecha. */
function inicioDeDia(d) {
  const copia = new Date(d);
  copia.setHours(0, 0, 0, 0);
  return copia;
}

/* =========================================================================
 * Estado y consumo
 * ====================================================================== */

/**
 * Estado de WhatsApp. Lo inyecta index.js con setEstadoWhatsapp: es el unico
 * que sabe si el cliente termino de vincularse.
 */
let estadoWhatsappFn = () => 'sin vincular';

// Registra la funcion que informa el estado de WhatsApp.
function setEstadoWhatsapp(fn) {
  if (typeof fn === 'function') estadoWhatsappFn = fn;
}

function estadoWhatsapp() {
  try {
    return estadoWhatsappFn();
  } catch (_) {
    return 'sin vincular';
  }
}

/** Ultimo codigo de vinculacion emitido. Lo inyecta index.js. */
let codigoVinculacionFn = () => null;

// Registra la funcion que devuelve el codigo de vinculacion vigente.
function setCodigoVinculacion(fn) {
  if (typeof fn === 'function') codigoVinculacionFn = fn;
}

function codigoVinculacion() {
  try {
    return codigoVinculacionFn();
  } catch (_) {
    return null;
  }
}

// Arma el resumen del sistema.
async function construirEstado() {
  const [users, messages, events, tasks, programadosActivos] = await Promise.all([
    db.User.countDocuments(),
    db.Message.countDocuments(),
    db.Event.countDocuments(),
    db.Task.countDocuments(),
    db.ScheduledMessage.countDocuments({ active: true }),
  ]);

  const vinculado = estadoWhatsapp() === 'vinculado';

  const estado = {
    sistema: 'OrbitaOs',
    hora: new Date().toISOString(),
    whatsapp: vinculado ? 'vinculado' : 'sin vincular',
    base: db.mongoose.connection.readyState === 1 ? 'conectada' : 'desconectada',
    ia: process.env.SPACE_BUNNY_API_KEY ? 'Space Bunny Alpha' : 'modo mock',
    uso_ia: ai.getUsage(),
    cron: process.env.CRON_REMINDERS || '*/1 * * * *',
    cron_programados: process.env.CRON_SCHEDULED || '*/1 * * * *',
    zona_horaria: process.env.TZ || 'America/Asuncion',
    sesiones_activas: sesion.activas(),
    conteos: {
      users,
      messages,
      events,
      tasks,
      programados: programadosActivos,
    },
  };

  // El codigo de emparejamiento se renueva cada pocos minutos. Se expone para
  // no tener que andar buscandolo en los logs del contenedor.
  const codigo = codigoVinculacion();
  if (!vinculado && codigo) {
    estado.codigo_vinculacion = codigo;
    estado.nota =
      'Ingresá este código en WhatsApp > Dispositivos vinculados > ' +
      'Vincular con número de teléfono. Se renueva cada pocos minutos: ' +
      'si falla, recargá el panel para ver el vigente.';
  }

  return estado;
}

/** GET /api/estado */
async function estado(req, res) {
  responder(res, 200, await construirEstado());
}

// El uso de ai_router y la serie diaria de respuestas, calculada desde los mensajes guardados.
async function consumo(req, res, ctx) {
  const dias = entero(ctx.query.get('dias'), 1, 90, 14);
  const desde = inicioDeDia(new Date(Date.now() - (dias - 1) * 86400000));

  const porDia = await db.Message.aggregate([
    { $match: { createdAt: { $gte: desde }, direction: 'outbound' } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        respuestas: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  responder(res, 200, {
    ...ai.getUsage(),
    dias,
    serie: porDia.map((d) => ({ dia: d._id, respuestas: d.respuestas })),
  });
}

/* =========================================================================
 * Resumen del panel
 * ====================================================================== */

// Todo lo que muestra la pantalla de inicio en una sola llamada: el panel no deberia hacer seis consultas para pintar el tablero de arriba.
async function resumen(req, res) {
  const ahora = new Date();
  const enSieteDias = new Date(ahora.getTime() + 7 * 86400000);
  const hoy = inicioDeDia(ahora);

  const [estadoSistema, proximosEventos, abiertas, porColumna, mensajesHoy] =
    await Promise.all([
      construirEstado(),
      db.Event.find({
        startAt: { $gte: ahora, $lte: enSieteDias },
        status: 'confirmed',
      })
        .sort({ startAt: 1 })
        .limit(8)
        .lean(),
      db.Task.find({ status: { $ne: 'done' } })
        .sort({ dueAt: 1 })
        .limit(100)
        .lean(),
      db.Task.aggregate([
        { $match: { status: { $ne: 'done' } } },
        { $group: { _id: '$status', total: { $sum: 1 } } },
      ]),
      db.Message.countDocuments({ createdAt: { $gte: hoy } }),
    ]);

  // Orden de atencion: primero lo vencido, despues lo urgente y alto.
  const prioridad = { urgent: 0, high: 1, medium: 2, low: 3 };
  const vencidas = abiertas.filter((t) => t.dueAt && new Date(t.dueAt) < ahora);
  const urgentes = abiertas
    .filter((t) => t.priority === 'urgent' || t.priority === 'high')
    .filter((t) => !vencidas.some((v) => String(v._id) === String(t._id)))
    .sort((a, b) => prioridad[a.priority] - prioridad[b.priority]);

  responder(res, 200, {
    estado: estadoSistema,
    proximos_eventos: proximosEventos,
    tareas_vencidas: vencidas.slice(0, 10),
    tareas_urgentes: urgentes.slice(0, 10),
    tablero: COLUMNAS.map((columna) => ({
      columna,
      total: (porColumna.find((c) => c._id === columna) || {}).total || 0,
    })),
    mensajes_hoy: mensajesHoy,
  });
}

/* =========================================================================
 * Mensajes
 * ====================================================================== */

/**
 * GET /api/mensajes?chat=&desde=&hasta=&direccion=&q=&limite=
 *
 * El historial completo: entrantes y salientes. Los mas nuevos primero.
 */
async function listarMensajes(req, res, ctx) {
  const filtro = {};

  const chat = texto(ctx.query.get('chat'), 60);
  if (chat) filtro.chatId = chat;

  const desde = fecha(ctx.query.get('desde'));
  const hasta = fecha(ctx.query.get('hasta'));
  if (desde || hasta) {
    filtro.createdAt = {};
    if (desde) filtro.createdAt.$gte = desde;
    if (hasta) filtro.createdAt.$lte = hasta;
  }

  const direccion = opcion(
    ctx.query.get('direccion'),
    ['inbound', 'outbound'],
    null
  );
  if (direccion) filtro.direction = direccion;

  const q = texto(ctx.query.get('q'), 80);
  if (q) filtro.body = { $regex: escaparRegex(q), $options: 'i' };

  const mensajes = await db.Message.find(filtro)
    .sort({ createdAt: -1 })
    .limit(limiteDe(ctx.query.get('limite'), 100, 500))
    .lean();

  responder(res, 200, { total: mensajes.length, mensajes });
}

// Una fila por chat, con el ultimo mensaje y el total.
async function listarConversaciones(req, res) {
  const conversaciones = await db.Message.aggregate([
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: '$chatId',
        ultimo: { $first: '$body' },
        ultimoAt: { $first: '$createdAt' },
        ultimaDireccion: { $first: '$direction' },
        total: { $sum: 1 },
        entrantes: { $sum: { $cond: [{ $eq: ['$direction', 'inbound'] }, 1, 0] } },
      },
    },
    { $sort: { ultimoAt: -1 } },
    { $limit: 200 },
  ]);

  // Se cruza con User para mostrar el nombre en vez del telefono pelado.
  const chats = conversaciones.map((c) => c._id);
  const personas = await db.User.find({ phone: { $in: chats } })
    .select('phone name firstName lastName')
    .lean();
  const porTelefono = new Map(personas.map((u) => [u.phone, u]));

  responder(res, 200, {
    conversaciones: conversaciones.map((c) => {
      const persona = porTelefono.get(c._id);
      return {
        chatId: c._id,
        telefono: c._id,
        nombre: persona ? nombreDe(persona) : c._id,
        ultimo: c.ultimo,
        ultimoAt: c.ultimoAt,
        ultimaDireccion: c.ultimaDireccion,
        total: c.total,
        entrantes: c.entrantes,
      };
    }),
  });
}

/* =========================================================================
 * Contactos (la lista blanca de WhatsApp)
 * ====================================================================== */

// Contacto y usuario del panel son el MISMO registro: es lo que hace que la lista blanca siga saliendo de una sola coleccion.
function verContacto(u) {
  return {
    id: String(u._id),
    username: u.username,
    phone: u.phone || null,
    name: u.name || '',
    firstName: u.firstName || '',
    lastName: u.lastName || '',
    birthday: u.birthday || null,
    role: u.role,
    allowed: u.allowed !== false,
    timezone: u.timezone || 'America/Asuncion',
    lastSeenAt: u.lastSeenAt || null,
    createdAt: u.createdAt || null,
  };
}

/** Traduce el error de indice unico de Mongo a un mensaje entendible. */
function mensajeDuplicado(err, telefonoValor) {
  if (err && err.code === 11000) {
    const campo = Object.keys(err.keyPattern || {})[0];
    if (campo === 'phone') {
      return `El teléfono ${telefonoValor} ya está asignado a otro contacto`;
    }
    if (campo === 'username') return 'Ese nombre de usuario ya existe';
    return 'Ya existe un registro con esos datos';
  }
  return null;
}

/** GET /api/contactos?q=&habilitados= */
async function listarContactos(req, res, ctx) {
  exigirAdmin(ctx);
  const filtro = {};

  const q = texto(ctx.query.get('q'), 80);
  if (q) {
    const patron = escaparRegex(q);
    filtro.$or = [
      { name: { $regex: patron, $options: 'i' } },
      { firstName: { $regex: patron, $options: 'i' } },
      { lastName: { $regex: patron, $options: 'i' } },
      { phone: { $regex: patron, $options: 'i' } },
      { username: { $regex: patron, $options: 'i' } },
    ];
  }

  if (ctx.query.get('habilitados') === '1') filtro.allowed = true;

  const contactos = await db.User.find(filtro).sort({ createdAt: 1 }).lean();
  responder(res, 200, {
    total: contactos.length,
    contactos: contactos.map(verContacto),
  });
}

// Alta de un numero habilitado.
async function crearContacto(req, res, ctx) {
  exigirAdmin(ctx);
  const cuerpo = ctx.cuerpo;
  const tel = telefonoValido(cuerpo.phone);

  // Sin nombre de usuario explicito se usa c<telefono>: es unico porque el
  // telefono tambien lo es.
  const username = usuarios.normalizeUsername(cuerpo.username || `c${tel}`);
  const password =
    String(cuerpo.password || '') || crypto.randomBytes(16).toString('hex');

  let usuario;
  try {
    usuario = await usuarios.createUser({
      username,
      password,
      phone: tel,
      name: texto(cuerpo.name, 80),
      firstName: texto(cuerpo.firstName, 60),
      lastName: texto(cuerpo.lastName, 60),
      birthday: fecha(cuerpo.birthday),
      role: opcion(cuerpo.role, ROLES, 'member'),
      allowed: cuerpo.allowed !== false,
      timezone: texto(cuerpo.timezone, 60) || 'America/Asuncion',
    });
  } catch (err) {
    throw new Error(mensajeDuplicado(err, tel) || err.message);
  }

  responder(res, 201, { contacto: verContacto(usuario) });
}

// Edita los campos informados y deja el resto como estaba.
async function editarContacto(req, res, ctx) {
  exigirAdmin(ctx);
  const cuerpo = ctx.cuerpo;
  const actual = await porId(db.User, ctx.params[0], 'Contacto');

  const cambios = {};

  if (tiene(cuerpo, 'firstName')) cambios.firstName = texto(cuerpo.firstName, 60);
  if (tiene(cuerpo, 'lastName')) cambios.lastName = texto(cuerpo.lastName, 60);
  if (tiene(cuerpo, 'birthday')) cambios.birthday = fecha(cuerpo.birthday);
  if (tiene(cuerpo, 'allowed')) cambios.allowed = Boolean(cuerpo.allowed);
  if (tiene(cuerpo, 'timezone')) cambios.timezone = texto(cuerpo.timezone, 60);

  if (tiene(cuerpo, 'role')) {
    const role = opcion(cuerpo.role, ROLES, null);
    if (!role) throw new Error('Rol inválido: owner, admin o member');
    cambios.role = role;
  }

  if (tiene(cuerpo, 'phone')) {
    const tel = telefonoValido(cuerpo.phone);
    if (tel !== actual.phone) {
      const ocupado = await db.User.findOne({
        phone: tel,
        _id: { $ne: actual._id },
      }).lean();
      if (ocupado) {
        throw new Error(`El teléfono ${tel} ya está asignado a otro contacto`);
      }
    }
    cambios.phone = tel;
  }

  // El nombre visible se recompone solo cuando cambian el nombre o el apellido
  // y no se mando un "name" explicito.
  if (tiene(cuerpo, 'name')) {
    cambios.name = texto(cuerpo.name, 80);
  } else if (cambios.firstName !== undefined || cambios.lastName !== undefined) {
    const juntos = [
      cambios.firstName === undefined ? actual.firstName : cambios.firstName,
      cambios.lastName === undefined ? actual.lastName : cambios.lastName,
    ]
      .filter(Boolean)
      .join(' ');
    if (juntos) cambios.name = juntos;
  }

  if (Object.keys(cambios).length === 0 && !cuerpo.password) {
    throw new Error('No se envió ningún campo para actualizar');
  }

  let actualizado = actual;
  if (Object.keys(cambios).length > 0) {
    try {
      actualizado = await db.User.findByIdAndUpdate(
        actual._id,
        { $set: cambios },
        { new: true }
      ).lean();
    } catch (err) {
      throw new Error(mensajeDuplicado(err, cambios.phone) || err.message);
    }
  }

  // Cambio de contrasena, si se pidio: va aparte porque necesita el hash.
  if (cuerpo.password) {
    await usuarios.changePassword(actual.username, cuerpo.password);
  }

  responder(res, 200, { contacto: verContacto(actualizado) });
}

// Borra el contacto.
async function borrarContacto(req, res, ctx) {
  exigirAdmin(ctx);
  const actual = await porId(db.User, ctx.params[0], 'Contacto');

  // Se delega en users.deleteUser para respetar la proteccion del ultimo owner.
  await usuarios.deleteUser(actual.username);

  responder(res, 200, { ok: true, username: actual.username });
}

/* =========================================================================
 * Eventos (el calendario)
 * ====================================================================== */

// Telefono dueno de un registro nuevo.
function duenoDe(cuerpo, ctx) {
  const tel = telefono(cuerpo.owner);
  if (tel) return telefonoValido(tel);
  if (ctx.sesion.phone) return ctx.sesion.phone;
  throw new Error(
    'Falta el teléfono destinatario: indicá uno o asignale un teléfono a tu usuario'
  );
}

/** GET /api/eventos?desde=&hasta=&owner=&status= */
async function listarEventos(req, res, ctx) {
  const filtro = {};

  const desde = fecha(ctx.query.get('desde'));
  const hasta = fecha(ctx.query.get('hasta'));
  if (desde || hasta) {
    filtro.startAt = {};
    if (desde) filtro.startAt.$gte = desde;
    if (hasta) filtro.startAt.$lte = hasta;
  }

  const owner = telefono(ctx.query.get('owner'));
  // Un miembro solo ve su propia agenda; los administradores ven todo.
  if (owner) filtro.owner = owner;
  else if (!esAdmin(ctx)) filtro.owner = ctx.sesion.phone || '__ninguno__';

  const status = opcion(ctx.query.get('status'), ESTADOS_EVENTO, null);
  if (status) filtro.status = status;

  const eventos = await db.Event.find(filtro)
    .sort({ startAt: 1 })
    .limit(limiteDe(ctx.query.get('limite'), 200, 500))
    .lean();

  responder(res, 200, { total: eventos.length, eventos });
}

/** POST /api/eventos */
async function crearEvento(req, res, ctx) {
  const cuerpo = ctx.cuerpo;
  const owner = duenoDe(cuerpo, ctx);

  const startAt = fecha(cuerpo.startAt || cuerpo.start_at);
  if (!startAt) throw new Error('Falta la fecha de inicio del evento');

  const endAt = fecha(cuerpo.endAt || cuerpo.end_at);
  if (endAt && endAt < startAt) {
    throw new Error('La fecha de fin no puede ser anterior a la de inicio');
  }

  const evento = await db.Event.create({
    title: texto(cuerpo.title, 200) || 'Sin título',
    description: texto(cuerpo.description, 2000),
    owner,
    createdBy: ctx.sesion.username,
    chatId: owner,
    startAt,
    endAt,
    location: texto(cuerpo.location, 300),
    status: opcion(cuerpo.status, ESTADOS_EVENTO, 'confirmed'),
    source: 'panel',
  });

  responder(res, 201, { evento: evento.toObject() });
}

/** PATCH /api/eventos/:id */
async function editarEvento(req, res, ctx) {
  const cuerpo = ctx.cuerpo;
  const actual = await porId(db.Event, ctx.params[0], 'Evento');

  // Un miembro solo toca su propia agenda.
  if (!esAdmin(ctx) && actual.owner !== ctx.sesion.phone) {
    throw new Error('Solo podés modificar los eventos de tu propia agenda');
  }

  const cambios = {};
  if (tiene(cuerpo, 'title')) cambios.title = texto(cuerpo.title, 200) || 'Sin título';
  if (tiene(cuerpo, 'description')) cambios.description = texto(cuerpo.description, 2000);
  if (tiene(cuerpo, 'location')) cambios.location = texto(cuerpo.location, 300);

  if (tiene(cuerpo, 'status')) {
    const status = opcion(cuerpo.status, ESTADOS_EVENTO, null);
    if (!status) throw new Error('Estado inválido: confirmed, cancelled o done');
    cambios.status = status;
  }
  if (tiene(cuerpo, 'startAt')) {
    const startAt = fecha(cuerpo.startAt);
    if (!startAt) throw new Error('Fecha de inicio inválida');
    cambios.startAt = startAt;
  }
  if (tiene(cuerpo, 'endAt')) cambios.endAt = fecha(cuerpo.endAt);

  if (Object.keys(cambios).length === 0) {
    throw new Error('No se envió ningún campo para actualizar');
  }

  const update = { $set: cambios };

  // Reprogramar reabre los recordatorios: si no se limpiaran, el aviso de 24h
  // no se volveria a enviar para la fecha nueva.
  const reprogramado =
    cambios.startAt && String(cambios.startAt) !== String(actual.startAt);
  if (reprogramado) {
    update.$set['reminders.h24'] = { sent: false, sentAt: null };
    update.$set['reminders.h2'] = { sent: false, sentAt: null };
  }

  const actualizado = await db.Event.findByIdAndUpdate(actual._id, update, {
    new: true,
  }).lean();

  responder(res, 200, { evento: actualizado });
}

/** DELETE /api/eventos/:id */
async function borrarEvento(req, res, ctx) {
  const actual = await porId(db.Event, ctx.params[0], 'Evento');
  if (!esAdmin(ctx) && actual.owner !== ctx.sesion.phone) {
    throw new Error('Solo podés borrar los eventos de tu propia agenda');
  }
  await db.Event.deleteOne({ _id: actual._id });
  responder(res, 200, { ok: true });
}

/* =========================================================================
 * Tareas (el pipeline / Kanban)
 * ====================================================================== */

// Devuelve las tareas ya agrupadas por columna, que es como las pinta el tablero.
async function listarTareas(req, res, ctx) {
  const filtro = {};

  const owner = telefono(ctx.query.get('owner'));
  if (owner) filtro.owner = owner;
  else if (!esAdmin(ctx)) filtro.owner = ctx.sesion.phone || '__ninguno__';

  const columna = opcion(ctx.query.get('status'), COLUMNAS, null);
  if (columna) filtro.status = columna;

  const q = texto(ctx.query.get('q'), 80);
  if (q) {
    const patron = escaparRegex(q);
    filtro.$or = [
      { title: { $regex: patron, $options: 'i' } },
      { description: { $regex: patron, $options: 'i' } },
      { labels: { $regex: patron, $options: 'i' } },
    ];
  }

  const tareas = await db.Task.find(filtro)
    .sort({ position: 1, createdAt: -1 })
    .limit(limiteDe(ctx.query.get('limite'), 300, 500))
    .lean();

  responder(res, 200, {
    total: tareas.length,
    tablero: COLUMNAS.map((nombre) => ({
      columna: nombre,
      tareas: tareas.filter((t) => t.status === nombre),
    })),
    columnas: COLUMNAS,
    prioridades: PRIORIDADES,
  });
}

/** POST /api/tareas */
async function crearTarea(req, res, ctx) {
  const cuerpo = ctx.cuerpo;
  const owner = duenoDe(cuerpo, ctx);

  const titulo = texto(cuerpo.title, 200);
  if (!titulo) throw new Error('La tarea necesita un título');

  const status = opcion(cuerpo.status, COLUMNAS, 'todo');

  // Se coloca al final de su columna: la ultima posicion + 1.
  const ultima = await db.Task.findOne({ owner, status })
    .sort({ position: -1 })
    .select('position')
    .lean();

  const tarea = await db.Task.create({
    title: titulo,
    description: texto(cuerpo.description, 4000),
    owner,
    createdBy: ctx.sesion.username,
    chatId: owner,
    status,
    priority: opcion(cuerpo.priority, PRIORIDADES, 'medium'),
    dueAt: fecha(cuerpo.dueAt),
    position: entero(cuerpo.position, 0, 100000, (ultima ? ultima.position : 0) + 1),
    labels: Array.isArray(cuerpo.labels)
      ? cuerpo.labels.map((l) => texto(l, 40)).filter(Boolean).slice(0, 10)
      : [],
    source: 'panel',
  });

  responder(res, 201, { tarea: tarea.toObject() });
}

// Es el movimiento del Kanban: el panel manda { status, position } al soltar una tarjeta en otra columna.
async function editarTarea(req, res, ctx) {
  const cuerpo = ctx.cuerpo;
  const actual = await porId(db.Task, ctx.params[0], 'Tarea');

  if (!esAdmin(ctx) && actual.owner !== ctx.sesion.phone) {
    throw new Error('Solo podés modificar las tareas de tu propia bandeja');
  }

  const cambios = {};

  if (tiene(cuerpo, 'title')) {
    const titulo = texto(cuerpo.title, 200);
    if (!titulo) throw new Error('La tarea necesita un título');
    cambios.title = titulo;
  }
  if (tiene(cuerpo, 'description')) cambios.description = texto(cuerpo.description, 4000);

  if (tiene(cuerpo, 'priority')) {
    const prioridad = opcion(cuerpo.priority, PRIORIDADES, null);
    if (!prioridad) throw new Error('Prioridad inválida: low, medium, high o urgent');
    cambios.priority = prioridad;
  }
  if (tiene(cuerpo, 'status')) {
    const columna = opcion(cuerpo.status, COLUMNAS, null);
    if (!columna) throw new Error(`Columna inválida: ${COLUMNAS.join(', ')}`);
    cambios.status = columna;
  }
  if (tiene(cuerpo, 'dueAt')) cambios.dueAt = fecha(cuerpo.dueAt);
  if (tiene(cuerpo, 'position')) {
    cambios.position = entero(cuerpo.position, 0, 100000, actual.position);
  }
  if (tiene(cuerpo, 'labels')) {
    cambios.labels = Array.isArray(cuerpo.labels)
      ? cuerpo.labels.map((l) => texto(l, 40)).filter(Boolean).slice(0, 10)
      : [];
  }

  // Reasignar a otra persona es cosa de administradores.
  if (tiene(cuerpo, 'owner')) {
    exigirAdmin(ctx);
    cambios.owner = telefonoValido(cuerpo.owner);
    cambios.chatId = cambios.owner;
  }

  if (Object.keys(cambios).length === 0) {
    throw new Error('No se envió ningún campo para actualizar');
  }

  const actualizada = await db.Task.findByIdAndUpdate(
    actual._id,
    { $set: cambios },
    { new: true }
  ).lean();

  responder(res, 200, { tarea: actualizada });
}

/** DELETE /api/tareas/:id */
async function borrarTarea(req, res, ctx) {
  const actual = await porId(db.Task, ctx.params[0], 'Tarea');
  if (!esAdmin(ctx) && actual.owner !== ctx.sesion.phone) {
    throw new Error('Solo podés borrar las tareas de tu propia bandeja');
  }
  await db.Task.deleteOne({ _id: actual._id });
  responder(res, 200, { ok: true });
}

// Es lo que permite "a Ana, el 12 de septiembre de cada año, mandarle feliz cumpleaños".

// Arma el objeto de recurrencia a partir del cuerpo de la peticion.
function recurrencia(cuerpo, base = {}) {
  const mode = opcion(cuerpo.mode, MODOS, base.mode || 'once');
  const datos = { mode };

  if (mode === 'once') {
    const runAt = fecha(cuerpo.runAt || cuerpo.run_at);
    if (!runAt) throw new Error('Un envío único necesita fecha y hora (runAt)');
    datos.runAt = runAt;
    return datos;
  }

  datos.time = hora(cuerpo.time || base.time);
  datos.timezone =
    texto(cuerpo.timezone, 60) || base.timezone || 'America/Asuncion';

  if (mode === 'yearly' || mode === 'monthly') {
    const day = entero(cuerpo.day, 1, 31, base.day);
    if (!day) throw new Error('Indicá el día del mes (1 a 31)');
    datos.day = day;
  }
  if (mode === 'yearly') {
    const month = entero(cuerpo.month, 1, 12, base.month);
    if (!month) throw new Error('Indicá el mes (1 a 12)');
    datos.month = month;
  }
  if (mode === 'weekly') {
    const weekday = entero(cuerpo.weekday, 0, 6, base.weekday);
    if (weekday === null) throw new Error('Indicá el día de la semana (0 a 6)');
    datos.weekday = weekday;
  }

  return datos;
}

/** Proyeccion para el panel, con la fecha del proximo envio ya calculada. */
function verProgramado(p) {
  return {
    id: String(p._id),
    to: p.to,
    chatId: p.chatId,
    title: p.title || '',
    body: p.body,
    mode: p.mode,
    runAt: p.runAt || null,
    month: p.month,
    day: p.day,
    weekday: p.weekday,
    time: p.time,
    timezone: p.timezone,
    active: p.active !== false,
    lastSentAt: p.lastSentAt || null,
    sentCount: p.sentCount || 0,
    owner: p.owner,
    createdAt: p.createdAt || null,
    proximo_envio: programados.calcularProximo(p, new Date()),
  };
}

/** GET /api/programados?owner=&activos= */
async function listarProgramados(req, res, ctx) {
  const filtro = {};

  const owner = telefono(ctx.query.get('owner'));
  if (owner) filtro.owner = owner;
  else if (!esAdmin(ctx)) filtro.owner = ctx.sesion.phone || '__ninguno__';

  if (ctx.query.get('activos') === '1') filtro.active = true;

  const lista = await db.ScheduledMessage.find(filtro)
    .sort({ createdAt: -1 })
    .limit(limiteDe(ctx.query.get('limite'), 200, 500))
    .lean();

  responder(res, 200, {
    total: lista.length,
    programados: lista.map(verProgramado),
    modos: MODOS,
  });
}

/** POST /api/programados */
async function crearProgramado(req, res, ctx) {
  const cuerpo = ctx.cuerpo;
  const to = duenoDe(cuerpo, ctx);

  const body = texto(cuerpo.body, 4000);
  if (!body) throw new Error('El mensaje no puede estar vacío');

  const doc = await db.ScheduledMessage.create({
    to,
    chatId: to,
    title: texto(cuerpo.title, 120),
    body,
    owner: to,
    createdBy: ctx.sesion.username,
    active: cuerpo.active !== false,
    source: 'panel',
    ...recurrencia(cuerpo),
  });

  responder(res, 201, { programado: verProgramado(doc.toObject()) });
}

/** PATCH /api/programados/:id */
async function editarProgramado(req, res, ctx) {
  const cuerpo = ctx.cuerpo;
  const actual = await porId(
    db.ScheduledMessage,
    ctx.params[0],
    'Mensaje programado'
  );

  if (!esAdmin(ctx) && actual.owner !== ctx.sesion.phone) {
    throw new Error('Solo podés editar los mensajes programados de tu propia agenda');
  }

  const cambios = {};

  if (tiene(cuerpo, 'title')) cambios.title = texto(cuerpo.title, 120);
  if (tiene(cuerpo, 'body')) {
    const body = texto(cuerpo.body, 4000);
    if (!body) throw new Error('El mensaje no puede estar vacío');
    cambios.body = body;
  }
  if (tiene(cuerpo, 'active')) cambios.active = Boolean(cuerpo.active);

  // Cambiar la recurrencia obliga a recalcularla entera: dejar el "mes" viejo
  // de un modo que ya no lo usa daria un proximo envio equivocado.
  const cambiaModo =
    tiene(cuerpo, 'mode') ||
    tiene(cuerpo, 'runAt') ||
    tiene(cuerpo, 'month') ||
    tiene(cuerpo, 'day') ||
    tiene(cuerpo, 'weekday') ||
    tiene(cuerpo, 'time');

  if (cambiaModo) {
    Object.assign(cambios, recurrencia(cuerpo, actual));
    // Los campos que el modo nuevo no usa quedan limpios en null.
    for (const campo of ['runAt', 'month', 'day', 'weekday']) {
      if (!(campo in cambios)) cambios[campo] = null;
    }
  }

  if (tiene(cuerpo, 'to')) {
    exigirAdmin(ctx);
    const to = telefonoValido(cuerpo.to);
    cambios.to = to;
    cambios.owner = to;
    cambios.chatId = to;
  }

  if (Object.keys(cambios).length === 0) {
    throw new Error('No se envió ningún campo para actualizar');
  }

  const actualizado = await db.ScheduledMessage.findByIdAndUpdate(
    actual._id,
    { $set: cambios },
    { new: true }
  ).lean();

  responder(res, 200, { programado: verProgramado(actualizado) });
}

/** DELETE /api/programados/:id */
async function borrarProgramado(req, res, ctx) {
  const actual = await porId(
    db.ScheduledMessage,
    ctx.params[0],
    'Mensaje programado'
  );
  if (!esAdmin(ctx) && actual.owner !== ctx.sesion.phone) {
    throw new Error('Solo podés borrar los mensajes programados de tu propia agenda');
  }
  await db.ScheduledMessage.deleteOne({ _id: actual._id });
  responder(res, 200, { ok: true });
}

/* =========================================================================
 * Exportacion
 * ====================================================================== */

module.exports = {
  // Estado y panel
  estado,
  consumo,
  resumen,
  construirEstado,
  setEstadoWhatsapp,
  setCodigoVinculacion,
  // Mensajes
  listarMensajes,
  listarConversaciones,
  // Contactos
  listarContactos,
  crearContacto,
  editarContacto,
  borrarContacto,
  // Eventos
  listarEventos,
  crearEvento,
  editarEvento,
  borrarEvento,
  // Tareas
  listarTareas,
  crearTarea,
  editarTarea,
  borrarTarea,
  // Mensajes programados
  listarProgramados,
  crearProgramado,
  editarProgramado,
  borrarProgramado,
};

