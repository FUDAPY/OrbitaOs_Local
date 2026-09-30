'use strict';
// OrbitaOs - router de la API y autenticacion del panel.

const sesion = require('./session');
const usuarios = require('./users');
const recursos = require('./api_recursos');
const { responder, fallo, leerCuerpo } = require('./api_util');

/* =========================================================================
 * Sesion
 * ====================================================================== */

/**
 * IP del cliente. Detras de un proxy la IP
 * real es la primera de X-Forwarded-For.
 */
function ipDe(req) {
  const reenviada = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  return reenviada || req.socket.remoteAddress || 'desconocida';
}

/** Proyeccion del usuario para el panel: sin hash ni datos internos. */
function publico(usuario) {
  return {
    username: usuario.username,
    name: usuario.name || usuario.username,
    firstName: usuario.firstName || '',
    lastName: usuario.lastName || '',
    role: usuario.role || 'member',
    phone: usuario.phone || null,
  };
}

// Inicia sesion y devuelve la cookie httpOnly con el token.
async function login(req, res, ctx) {
  const ip = ipDe(req);
  if (sesion.bloqueado(ip)) {
    return fallo(res, 429, 'Demasiados intentos fallidos. Probá de nuevo en 10 minutos.');
  }

  const username = usuarios.normalizeUsername(ctx.cuerpo.username);
  const password = String(ctx.cuerpo.password || '');
  if (!username || !password) {
    return fallo(res, 400, 'Usuario y contraseña son obligatorios');
  }

  const usuario = await usuarios.authenticate(username, password);
  if (!usuario) {
    sesion.registrarFallo(ip);
    // Un solo mensaje para los dos casos: no se revela si el usuario existe.
    return fallo(res, 401, 'Usuario o contraseña incorrectos');
  }

  sesion.limpiarIntentos(ip);
  const token = sesion.crear(usuario);
  responder(
    res,
    200,
    { usuario: publico(usuario) },
    { 'Set-Cookie': sesion.cookieDe(req, token) }
  );
}

async function logout(req, res) {
  sesion.cerrar(sesion.leerCookies(req)[sesion.COOKIE]);
  responder(res, 200, { ok: true }, { 'Set-Cookie': sesion.cookieVacia(req) });
}

/** Devuelve el usuario de la sesion abierta. */
async function verSesion(req, res, ctx) {
  responder(res, 200, { usuario: ctx.sesion });
}


/** Cliente de WhatsApp, para acciones que pueden disparar un envio. */
let clienteGlobal = null;

// Registra el cliente de WhatsApp para que la API pueda usarlo.
function setCliente(client) {
  clienteGlobal = client || null;
}

/* =========================================================================
 * Rutas
 * ====================================================================== */

// Tabla de rutas.
const RUTAS = [
  { metodo: 'POST', patron: /^\/api\/login$/, publico: true, handler: login },
  { metodo: 'POST', patron: /^\/api\/logout$/, handler: logout },
  { metodo: 'GET', patron: /^\/api\/sesion$/, handler: verSesion },

  // --- Resumen y consumo ---
  { metodo: 'GET', patron: /^\/api\/estado$/, handler: recursos.estado },
  { metodo: 'GET', patron: /^\/api\/consumo$/, handler: recursos.consumo },
  { metodo: 'GET', patron: /^\/api\/resumen$/, handler: recursos.resumen },

  // --- Mensajes ---
  { metodo: 'GET', patron: /^\/api\/mensajes$/, handler: recursos.listarMensajes },
  { metodo: 'GET', patron: /^\/api\/conversaciones$/, handler: recursos.listarConversaciones },

  // --- Contactos (la lista blanca de WhatsApp) ---
  { metodo: 'GET', patron: /^\/api\/contactos$/, handler: recursos.listarContactos },
  { metodo: 'POST', patron: /^\/api\/contactos$/, handler: recursos.crearContacto },
  { metodo: 'PATCH', patron: /^\/api\/contactos\/([^/]+)$/, handler: recursos.editarContacto },
  { metodo: 'DELETE', patron: /^\/api\/contactos\/([^/]+)$/, handler: recursos.borrarContacto },

  // --- Eventos (el calendario) ---
  { metodo: 'GET', patron: /^\/api\/eventos$/, handler: recursos.listarEventos },
  { metodo: 'POST', patron: /^\/api\/eventos$/, handler: recursos.crearEvento },
  { metodo: 'PATCH', patron: /^\/api\/eventos\/([^/]+)$/, handler: recursos.editarEvento },
  { metodo: 'DELETE', patron: /^\/api\/eventos\/([^/]+)$/, handler: recursos.borrarEvento },

  // --- Tareas (el pipeline) ---
  { metodo: 'GET', patron: /^\/api\/tareas$/, handler: recursos.listarTareas },
  { metodo: 'POST', patron: /^\/api\/tareas$/, handler: recursos.crearTarea },
  { metodo: 'PATCH', patron: /^\/api\/tareas\/([^/]+)$/, handler: recursos.editarTarea },
  { metodo: 'DELETE', patron: /^\/api\/tareas\/([^/]+)$/, handler: recursos.borrarTarea },

  // --- Mensajes programados (cumpleanos y avisos por fecha) ---
  { metodo: 'GET', patron: /^\/api\/programados$/, handler: recursos.listarProgramados },
  { metodo: 'POST', patron: /^\/api\/programados$/, handler: recursos.crearProgramado },
  { metodo: 'PATCH', patron: /^\/api\/programados\/([^/]+)$/, handler: recursos.editarProgramado },
  { metodo: 'DELETE', patron: /^\/api\/programados\/([^/]+)$/, handler: recursos.borrarProgramado },
];

// Codigo HTTP que corresponde a un error.
function codigoDeError(err) {
  if (!err) return 400;
  if (Number.isInteger(err.status)) return err.status;
  const nombre = err.name || 'Error';
  return nombre === 'Error' ? 400 : 500;
}

/* =========================================================================
 * Despachador
 * ====================================================================== */

// Atiende una peticion de la API.
async function manejar(req, res, url) {
  if (!url.pathname.startsWith('/api/')) return false;

  const ruta = RUTAS.find(
    (r) => r.metodo === req.method && r.patron.test(url.pathname)
  );
  if (!ruta) {
    fallo(res, 404, `ruta no encontrada: ${req.method} ${url.pathname}`);
    return true;
  }

  const ctx = {
    params: ruta.patron.exec(url.pathname).slice(1),
    query: url.searchParams,
    cuerpo: {},
    cliente: clienteGlobal,
  };

  if (!ruta.publico) {
    const actual = sesion.dePeticion(req);
    if (!actual) {
      fallo(res, 401, 'sesión requerida');
      return true;
    }
    ctx.sesion = actual;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      ctx.cuerpo = await leerCuerpo(req);
    } catch (err) {
      fallo(res, 400, err.message);
      return true;
    }
  }

  try {
    await ruta.handler(req, res, ctx);
  } catch (err) {
    const codigo = codigoDeError(err);
    if (codigo >= 500) {
      // El detalle va al log; al cliente no se le muestran tripas del servidor.
      console.error(`[api] ${req.method} ${url.pathname}: ${err.message}`);
      fallo(res, codigo, 'Error interno del servidor');
      return true;
    }
    fallo(res, codigo, err.message);
  }
  return true;
}

module.exports = { manejar, setCliente, RUTAS, publico, codigoDeError };

