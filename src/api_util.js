'use strict';
// OrbitaOs - utilidades compartidas de la API.

/** Limite del cuerpo: el panel solo manda JSON chico. */
const MAX_CUERPO = 256 * 1024;

// Listas cerradas: tienen que coincidir con los enum de los esquemas.
const COLUMNAS = ['backlog', 'todo', 'in_progress', 'review', 'done'];
const PRIORIDADES = ['low', 'medium', 'high', 'urgent'];
const ESTADOS_EVENTO = ['confirmed', 'cancelled', 'done'];
const ROLES = ['owner', 'admin', 'member'];
const MODOS = ['once', 'yearly', 'monthly', 'weekly', 'daily'];

const ETIQUETA_COLUMNA = {
  backlog: 'Pendientes',
  todo: 'Por hacer',
  in_progress: 'En curso',
  review: 'Revisión',
  done: 'Terminadas',
};

const ETIQUETA_PRIORIDAD = {
  low: 'Baja',
  medium: 'Media',
  high: 'Alta',
  urgent: 'Urgente',
};

function responder(res, status, cuerpo, cabeceras = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    // Datos privados: que el navegador y los proxies no los guarden.
    'Cache-Control': 'no-store',
    ...cabeceras,
  });
  res.end(JSON.stringify(cuerpo));
}

function fallo(res, status, mensaje) {
  responder(res, status, { error: mensaje });
}

/** Lee y parsea el cuerpo JSON, con tope de tamano. */
function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    let datos = '';
    req.on('data', (trozo) => {
      datos += trozo;
      if (datos.length > MAX_CUERPO) {
        reject(new Error('cuerpo demasiado grande'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!datos.trim()) return resolve({});
      try {
        resolve(JSON.parse(datos));
      } catch (_) {
        reject(new Error('JSON invalido'));
      }
    });
    req.on('error', reject);
  });
}

/* -------------------------------------------------------------------------
 * Validacion
 * ---------------------------------------------------------------------- */

/** Texto recortado, con tope de largo. */
function texto(valor, max = 500) {
  return String(valor === undefined || valor === null ? '' : valor)
    .trim()
    .slice(0, max);
}

/** Telefono: solo digitos. */
function telefono(valor) {
  return String(valor || '').replace(/\D/g, '').slice(0, 20);
}

/** Fecha valida o null. */
function fecha(valor) {
  if (!valor) return null;
  const d = valor instanceof Date ? valor : new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Entero dentro de un rango, o el valor por defecto. */
function entero(valor, min, max, porDefecto = null) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < min || n > max) return porDefecto;
  return n;
}

/** Valor de una lista cerrada, o el valor por defecto. */
function opcion(valor, permitidos, porDefecto) {
  return permitidos.includes(valor) ? valor : porDefecto;
}

/** Hora local HH:MM. */
function hora(valor) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(texto(valor, 5));
  return m ? m[0] : '09:00';
}

// Numero de WhatsApp en formato internacional.
function telefonoValido(valor) {
  const limpio = telefono(valor);
  if (!/^\d{8,20}$/.test(limpio)) {
    throw new Error('Teléfono inválido: entre 8 y 20 dígitos, con prefijo de país');
  }
  return limpio;
}

module.exports = {
  MAX_CUERPO,
  COLUMNAS,
  PRIORIDADES,
  ESTADOS_EVENTO,
  ROLES,
  MODOS,
  ETIQUETA_COLUMNA,
  ETIQUETA_PRIORIDAD,
  responder,
  fallo,
  leerCuerpo,
  texto,
  telefono,
  fecha,
  entero,
  opcion,
  hora,
  telefonoValido,
};
