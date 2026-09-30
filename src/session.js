'use strict';
// OrbitaOs - sesiones del panel web.

const crypto = require('crypto');

const COOKIE = 'orbita_sesion';
const TTL_MS = Number(process.env.SESSION_TTL_HOURS || 12) * 60 * 60 * 1000;

/** token -> { username, name, role, expiresAt } */
const sesiones = new Map();

// Crea una sesion para un usuario ya autenticado.
function crear(usuario) {
  const token = crypto.randomBytes(32).toString('hex');
  sesiones.set(token, {
    username: usuario.username,
    name: usuario.name || usuario.username,
    role: usuario.role || 'member',
    // Se guarda el telefono para poder filtrar "mis" cosas si hiciera falta.
    phone: usuario.phone || null,
    expiresAt: Date.now() + TTL_MS,
  });
  return token;
}

// Devuelve la sesion asociada a un token, si sigue vigente.
function obtener(token) {
  if (!token) return null;
  const sesion = sesiones.get(token);
  if (!sesion) return null;
  if (sesion.expiresAt <= Date.now()) {
    sesiones.delete(token);
    return null;
  }
  return sesion;
}

// Cierra una sesion.
function cerrar(token) {
  if (token) sesiones.delete(token);
}

/** Elimina las sesiones vencidas. Se llama en cada validacion. */
function limpiar() {
  const ahora = Date.now();
  for (const [token, sesion] of sesiones) {
    if (sesion.expiresAt <= ahora) sesiones.delete(token);
  }
}

// Lee las cookies de una peticion HTTP.
function leerCookies(req) {
  const cabecera = req.headers.cookie || '';
  const cookies = {};
  for (const parte of cabecera.split(';')) {
    const corte = parte.indexOf('=');
    if (corte < 1) continue;
    const nombre = parte.slice(0, corte).trim();
    cookies[nombre] = decodeURIComponent(parte.slice(corte + 1).trim());
  }
  return cookies;
}

// Recupera la sesion de una peticion.
function dePeticion(req) {
  limpiar();
  return obtener(leerCookies(req)[COOKIE]);
}

/** Indica si la peticion llego por HTTPS (el proxy agrega X-Forwarded-Proto). */
function esHttps(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https';
}

// Cookie de sesion, lista para el encabezado Set-Cookie.
function cookieDe(req, token) {
  const partes = [
    `${COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.floor(TTL_MS / 1000)}`,
  ];
  if (esHttps(req)) partes.push('Secure');
  return partes.join('; ');
}

/** Cookie que borra la sesion en el navegador. */
function cookieVacia(req) {
  const partes = [`${COOKIE}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (esHttps(req)) partes.push('Secure');
  return partes.join('; ');
}

// Control de fuerza bruta por IP: 8 intentos fallidos cada 10 minutos.
const intentos = new Map();
const MAX_INTENTOS = Number(process.env.LOGIN_MAX_ATTEMPTS || 8);
const VENTANA_MS = 10 * 60 * 1000;

// Registra un intento fallido de acceso.
function registrarFallo(ip) {
  const ahora = Date.now();
  const registro = intentos.get(ip) || { cuenta: 0, desde: ahora };
  if (ahora - registro.desde > VENTANA_MS) {
    registro.cuenta = 0;
    registro.desde = ahora;
  }
  registro.cuenta += 1;
  intentos.set(ip, registro);
}

// Indica si una IP supero el limite de intentos.
function bloqueado(ip) {
  const registro = intentos.get(ip);
  if (!registro) return false;
  if (Date.now() - registro.desde > VENTANA_MS) {
    intentos.delete(ip);
    return false;
  }
  return registro.cuenta >= MAX_INTENTOS;
}

// Limpia los intentos de una IP tras un acceso correcto.
function limpiarIntentos(ip) {
  intentos.delete(ip);
}

/** Cantidad de sesiones activas, para el diagnostico. */
function activas() {
  limpiar();
  return sesiones.size;
}

module.exports = {
  COOKIE,
  TTL_MS,
  crear,
  obtener,
  cerrar,
  limpiar,
  leerCookies,
  dePeticion,
  cookieDe,
  cookieVacia,
  esHttps,
  registrarFallo,
  bloqueado,
  limpiarIntentos,
  activas,
};
