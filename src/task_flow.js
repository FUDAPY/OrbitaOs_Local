'use strict';
// OrbitaOs - flujo guiado de carga de tareas.

const { Task } = require('./database');
const { resolveEventDate } = require('./ai_router');

/** Pasos del flujo, en orden. */
const PASOS = ['titulo', 'asignado', 'cuando', 'prioridad'];

/** El flujo caduca si el usuario no responde en este tiempo. */
const TIMEOUT_MS = 15 * 60 * 1000;

/** Flujos activos, por chat. En memoria: un reinicio los descarta. */
const flujos = new Map();

/** Respuestas que toman el valor por defecto del paso actual. */
const SALTAR = ['x', '-', 'nada', 'default', 'el mismo', 'yo', 'propio'];

/** Palabras que abortan el alta por completo. */
const CANCELAR = ['cancelar', 'cancela', 'exit', 'salir', 'olvidalo'];

/** Palabras clave para detectar una intención de alta sin gastar tokens. */
const INTENCION = new RegExp(
  '^\\s*(/|!)?\\s*(crear|crea|agregar|agrega|nueva|nuevo|anota|anotar|necesito|quiero|pendiente)\\b[^\\n]{0,40}?\\btarea\\b',
  'i'
);

/** Mapea texto libre a una prioridad valida. */
function interpretarPrioridad(texto) {
  const t = String(texto || '').toLowerCase();
  if (/\b(urgent|urgente|critic|asap|bloquea|paraliza)\b/.test(t)) return 'urgent';
  if (/\b(alta|high|importante|urgente ya|prioritario)\b/.test(t)) return 'high';
  if (/\b(baja|low|tranquilo|cuando pueda)\b/.test(t)) return 'low';
  return 'medium';
}

// Indica si un mensaje es un intento de dar de alta una tarea.
function detectarIntencion(texto) {
  const t = String(texto || '');
  if (INTENCION.test(t)) return true;
  // El comando explicito siempre abre el flujo.
  if (/^\s*\/?(tarea|nueva\s*tarea)\s*$/i.test(t)) return true;
  return false;
}

/** Convierte el texto de "cuando" en una fecha, o null si no se entiende. */
function interpretarCuando(texto) {
  return resolveEventDate({ date: String(texto || '').trim() });
}

/** Limpia un valor para evitar inyeccion de formato de WhatsApp. */
function limpiar(texto) {
  return String(texto || '').replace(/[*_`~]/g, '').trim().slice(0, 200);
}

// Inicia (o reinicia) el flujo de carga para un chat.
function iniciar(chatId, base = {}) {
  const flujo = {
    chatId,
    paso: 0,
    datos: {
      titulo: limpiar(base.titulo || ''),
      asignado: limpiar(base.asignado || ''),
      cuando: null,
      prioridad: base.prioridad || '',
    },
    inicio: Date.now(),
    ultimo: Date.now(),
  };
  flujos.set(chatId, flujo);
  return flujo;
}

// Indica si hay un flujo activo para ese chat.
function estaActivo(chatId) {
  const f = flujos.get(chatId);
  if (!f) return false;
  if (Date.now() - f.ultimo > TIMEOUT_MS) {
    flujos.delete(chatId);
    return false;
  }
  return true;
}

/** Cancela el flujo de un chat. */
function cancelar(chatId) {
  return flujos.delete(chatId);
}

/** Devuelve el flujo activo o null. */
function obtener(chatId) {
  return flujos.get(chatId) || null;
}

/** Cantidad de flujos activos (para diagnostico). */
function totalActivos() {
  return flujos.size;
}

/* -------------------------------------------------------------------------
 * Preguntas
 * ---------------------------------------------------------------------- */

// Devuelve la pregunta del paso actual.
function preguntaActual(flujo) {
  const paso = PASOS[flujo.paso];
  if (!paso) return '';

  switch (paso) {
    case 'titulo':
      return '📝 *¿Qué tarea es?*\n\nEscribí el titulo. Ej: llamar al proveedor';
    case 'asignado':
      return '👤 *¿Para quién es?*\n\nUn nombre o "yo" si es para vos.';
    case 'cuando':
      return '🗓 *¿Para cuándo?*\n\nEj: mañana, el 12/09, viernes, en 2 días.\nRespondé "x" si no tiene fecha.';
    case 'prioridad':
      return '🚦 *¿Qué prioridad?*\n\n• `alta` o `urgente`\n• `media` (por defecto)\n• `baja`\n\nRespondé "x" para dejarla en media.';
    default:
      return '';
  }
}

/** Texto de arranque del flujo. */
function saludoInicial(flujo) {
  return (
    '✅ *Alta de tarea*\n\n' +
    preguntaActual(flujo) +
    '\n\n_Cancelás con "cancelar". En cualquier paso podés escribir "saltar"._'
  );
}

/** Resumen de los datos recogidos, para confirmar. */
function resumen(datos) {
  const lineas = ['📋 *Revisemos*', ''];
  lineas.push(`• *Tarea:* ${datos.titulo || '(sin título)'}`);
  lineas.push(`• *Asignada a:* ${datos.asignado || 'yo'}`);
  lineas.push(
    `• *Vence:* ${datos.cuando ? formatearFecha(datos.cuando) : 'sin fecha'}`
  );
  lineas.push(`• *Prioridad:* ${datos.prioridad || 'medium'}`);
  return lineas.join('\n');
}

/** Formatea una fecha en texto legible. */
function formatearFecha(fecha) {
  try {
    return new Intl.DateTimeFormat('es-AR', {
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: process.env.REMINDER_TIMEZONE || 'America/Asuncion',
    }).format(fecha);
  } catch (_) {
    return fecha.toISOString();
  }
}

/* -------------------------------------------------------------------------
 * Procesamiento
 * ---------------------------------------------------------------------- */

/** Texto de confirmacion final. */
function pedirConfirmacion(datos) {
  return (
    resumen(datos) +
    '\n\n✅ Respondé *listo* para guardarla, o *cancelar* para descartarla.'
  );
}

// Procesa la respuesta del usuario en el paso actual.
async function procesar(chatId, texto, ctx) {
  const flujo = flujos.get(chatId);
  if (!flujo) return { reply: '', creada: null, cancelado: false };

  flujo.ultimo = Date.now();
  const limpio = limpiar(texto);
  const minus = limpio.toLowerCase();

  // --- Abortar ---
  if (CANCELAR.includes(minus)) {
    flujos.delete(chatId);
    return {
      reply: '🚫 Alta cancelada. No se creó ninguna tarea.',
      creada: null,
      cancelado: true,
    };
  }

  // --- Cerrar ya, con lo que haya ---
  const cerrar = /^(listo|ok|confirmar|guardar|dale|si|yes)$/.test(minus);
  // --- Saltar el resto con los valores por defecto ---
  const saltarTodo = /^(saltar|ya|terminar|listo)$/.test(minus);

  // Si ya se recogieron todos los pasos, cualquier otra cosa se toma por confirmacion.
  if (flujo.paso >= PASOS.length && !cerrar) {
    return confirmar(chatId, ctx);
  }

  if (saltarTodo && !cerrar) {
    flujo.paso = PASOS.length;
    return confirmar(chatId, ctx);
  }

  const paso = PASOS[flujo.paso];
  const usarDefault = SALTAR.includes(minus);

  if (paso === 'titulo') {
    if (!usarDefault && !limpio) {
      return { reply: 'Necesito un título. ¿Qué tarea es?', creada: null, cancelado: false };
    }
    flujo.datos.titulo = usarDefault ? '' : limpio;
  } else if (paso === 'asignado') {
    // "yo" o "x" significa que la tarea es para quien la creo.
    flujo.datos.asignado = usarDefault ? '' : limpio;
  } else if (paso === 'cuando') {
    if (usarDefault) {
      flujo.datos.cuando = null;
    } else {
      const fecha = interpretarCuando(limpio);
      if (!fecha) {
        return {
          reply:
            '🤔 No entendí la fecha. Probá con algo como:\n' +
            '• `mañana`\n• `el 12/09`\n• `viernes`\n' +
            '• `2026-10-05T14:00:00Z`\n\nO respondé *x* si no tiene fecha.',
          creada: null,
          cancelado: false,
        };
      }
      flujo.datos.cuando = fecha;
    }
  } else if (paso === 'prioridad') {
    flujo.datos.prioridad = usarDefault ? 'medium' : interpretarPrioridad(limpio);
  }

  // Avanza al paso siguiente. Si se salta con "saltar", completa lo que falta.
  flujo.paso += 1;
  if (flujo.paso >= PASOS.length) {
    return confirmar(chatId, ctx);
  }

  return {
    reply: preguntaActual(flujo),
    creada: null,
    cancelado: false,
  };
}

// Crea la tarea con los datos recogidos y cierra el flujo.
async function confirmar(chatId, ctx) {
  const flujo = flujos.get(chatId);
  if (!flujo) return { reply: '', creada: null, cancelado: false };

  const { titulo, asignado, cuando, prioridad } = flujo.datos;

  if (!titulo) {
    flujos.delete(chatId);
    return {
      reply: '❌ Necesito al menos el título de la tarea. Volvé a empezar con `/tarea`.',
      creada: null,
      cancelado: false,
    };
  }

  // "asignado" es un nombre libre: se guarda como etiqueta. Si viene vacío,
  // la tarea es del propio solicitante.
  const etiquetas = [];
  if (asignado && !/^(yo|el mismo|propio|nosotros)$/i.test(asignado)) {
    etiquetas.push(asignado.toLowerCase());
  }

  const last = await Task.findOne({ owner: ctx.owner, status: 'todo' })
    .sort({ position: -1 })
    .lean();

  const tarea = await Task.create({
    title: titulo,
    description: '',
    owner: ctx.owner,
    createdBy: ctx.from,
    chatId: ctx.chatId,
    status: 'todo',
    priority: prioridad || 'medium',
    dueAt: cuando || null,
    position: (last && last.position ? last.position : 0) + 1,
    labels: etiquetas,
    source: 'flujo',
  });

  flujos.delete(chatId);

  const lineas = [
    '✅ *Tarea creada*',
    '',
    `*${tarea.title}*`,
    `🚦 Prioridad: ${tarea.priority}`,
  ];
  if (tarea.dueAt) lineas.push(`📅 Vence: ${formatearFecha(tarea.dueAt)}`);
  if (etiquetas.length) lineas.push(`👤 ${asignado}`);
  lineas.push('', '¿Querés otra? Escribí `/tarea`.');

  return { reply: lineas.join('\n'), creada: tarea, cancelado: false };
}

module.exports = {
  iniciar,
  procesar,
  confirmar,
  estaActivo,
  cancelar,
  obtener,
  totalActivos,
  saludoInicial,
  preguntaActual,
  interpretarPrioridad,
  interpretarCuando,
  detectarIntencion,
  limpiar,
  resumen,
  formatearFecha,
  PASOS,
  TIMEOUT_MS,
};



