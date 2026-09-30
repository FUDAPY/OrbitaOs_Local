'use strict';
// OrbitaOs - enrutador de intencion hacia Space Bunny Alpha.

const web = require('./web_search');

const MOCK_FLAG = '__MOCK__';

/** Intenciones validas del sistema. */
const INTENTS = [
  'chat',
  'schedule_event',
  'create_document',
  'add_task',
  'update_task',
];

/**
 * Zona horaria de la operacion. Se usa para el contexto temporal que recibe
 * el modelo y para formatear las fechas en las respuestas.
 */
const TIMEZONE = () => process.env.TZ || 'America/Asuncion';

// Mensajes predeterminados EXACTOS que el modelo debe usar cuando faltan datos.
const MISSING_EVENT = [
  'Para agendar, por favor indícame:',
  '📅 Fecha',
  '⏰ Hora',
  '📝 Qué cosa (motivo)',
  '📍 Dónde',
].join('\n');

const MISSING_TASK = [
  'Para crear la tarea necesito:',
  '👤 Para quién',
  '✅ Qué tarea',
  '🔥 Prioridad',
  '⏳ Fecha límite',
].join('\n');

// Fecha y hora actuales en la zona de operacion.
function momentoActual() {
  const ahora = new Date();
  const opciones = {
    timeZone: TIMEZONE(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('es-AR', opciones)
      .formatToParts(ahora)
      .map((p) => [p.type, p.value])
  );
  return {
    date: `${partes.year}-${partes.month}-${partes.day}`,
    time: `${partes.hour}:${partes.minute}`,
    iso: ahora.toISOString(),
  };
}

// System prompt de Space Bunny Alpha.
function buildSystemPrompt() {
  const ahora = momentoActual();
  return [
    'Eres Space Bunny Alpha, el motor de inteligencia artificial de OrbitaOs, un asistente de operaciones por WhatsApp.',
    'Solo recibes mensajes de usuarios que ya han sido validados por el sistema en una lista blanca.',
    '',
    'TU ROL PRINCIPAL:',
    'Actúas como un enrutador de intenciones. SOLO DEBES UTILIZAR TU CAPACIDAD DE GENERACIÓN DE TEXTO INVENTIVA para "conversación libre" y "generar documentos".',
    'Para agendar citas o crear tareas, tu objetivo NO es generar texto creativo, sino extraer los datos y responder ESTRICTAMENTE con los mensajes predeterminados para solicitar la información faltante.',
    '',
    'REGLA ABSOLUTA:',
    'Tu respuesta DEBE ser EXCLUSIVAMENTE un objeto JSON válido. Sin bloques de código Markdown, sin saludos iniciales ni texto fuera del JSON.',
    '',
    'ESTRUCTURA DEL JSON:',
    '{',
    '  "intent": "<intent_name>",',
    '  "response_text": "<respuesta al usuario segun las reglas de cada intención>",',
    '  "data": { <datos_extraidos> }',
    '}',
    '',
    'REGLAS DE INTENCIONES (ESTRICTAS):',
    '',
    '1. "chat" (Conversación libre)',
    '   - Uso de IA: SÍ.',
    '   - response_text: Responde libremente de forma natural, amigable y breve (usando emojis).',
    '   - data: {}',
    '',
    '2. "create_document" (Generar documento)',
    '   - Uso de IA: SÍ (Solo texto plano).',
    '   - response_text: "📄 Aquí tienes el documento solicitado:" (o un mensaje breve confirmando la creación).',
    '   - data: {',
    '       "type": "string (ej: acta, informe)",',
    '       "title": "string",',
    '       "content": "string (CONTENIDO GENERADO ESTRICTAMENTE EN TEXTO PLANO, sin formatos complejos, sin markdown)",',
    '       "format": "texto plano"',
    '     }',
    '',
    '3. "schedule_event" (Agendar cita/evento)',
    '   - Uso de IA: NO (Solo extracción).',
    `   - response_text: Si faltan datos, DEBES USAR EXACTAMENTE este mensaje predeterminado: "${MISSING_EVENT}". (Si el usuario ya proporcionó todos los datos, responde confirmando la agenda).`,
    '   - data: {',
    '       "title": "string o null",',
    '       "start_at": "string o null",',
    '       "location": "string o null"',
    '     }',
    '',
    '4. "add_task" (Crear tarea)',
    '   - Uso de IA: NO (Solo extracción).',
    `   - response_text: Si faltan datos, DEBES USAR EXACTAMENTE este mensaje predeterminado: "${MISSING_TASK}". (Si el usuario ya proporcionó todo, confirma la creación).`,
    '   - data: {',
    '       "assignee": "string o null (para quién)",',
    '       "title": "string o null (qué tarea)",',
    '       "priority": "string o null",',
    '       "due_at": "string o null"',
    '     }',
    '',
    '5. "update_task" (Actualizar tarea)',
    '   - Uso de IA: NO.',
    '   - response_text: Mensaje predeterminado confirmando la actualización (ej: "✅ Tarea actualizada").',
    '   - data: { "task_id": "string", "status": "string" }',
    '',
    'CONTEXTO TEMPORAL:',
    `La fecha y hora actual es: ${ahora.date} - ${ahora.time} (Zona horaria: ${TIMEZONE()}).`,
  ].join('\n');
}


// Detecta intencion y datos con reglas locales (modo sin IA).
function mockRoute(text) {
  const t = (text || '').toLowerCase().trim();
  const result = { [MOCK_FLAG]: true, intent: 'chat', response_text: '', data: {} };

  // --- Actualizar tarea (se evalua antes de crear: "completar la tarea X" es
  // una actualizacion, no una tarea nueva) ---
  if (/\b(complet|completar|cerrar|terminar|finalizar|mover|actualizar|marcar)\w*\b.*\b(tarea|pendiente)\b/.test(t)) {
    const done = /\b(complet|completar|cerrar|terminar|finalizar)\w*\b/.test(t);
    result.intent = 'update_task';
    result.data = { status: done ? 'done' : 'in_progress', notes: t };
    result.response_text = done
      ? 'Entendido, marco la tarea como completada.'
      : 'Entendido, muevo la tarea a En progreso.';
    return result;
  }

  // --- Crear tarea ---
  if (/\b(tarea|pendiente|recordatorio|to do)\b/.test(t)) {
    const title = t
      .replace(/^\s*(crea|crear|agrega|agregar|nueva|nuevo|anota|recordar)\s*(una\s+)?(tarea|pendiente)?\s*[:,-]?\s*/i, '')
      .trim();
    const urgent = /\b(urgente|asap|critical)\b/.test(t);
    const high = /\b(prioridad\s+alta|importante)\b/.test(t);
    result.intent = 'add_task';
    result.data = {
      title: title || t,
      priority: urgent ? 'urgent' : high ? 'high' : 'medium',
      status: 'todo',
    };
    result.response_text = 'Tarea registrada en el pipeline.';
    return result;
  }

  // --- Crear documento ---
  if (/\b(documento|documentacion|informe|acta|contrato|reporte|minuta)\b/.test(t)) {
    result.intent = 'create_document';
    result.data = {
      type: 'document',
      title: t,
      content: text,
      format: 'md',
      tags: [],
    };
    result.response_text = 'Documento creado.';
    return result;
  }

  // --- Agendar evento ---
  if (/\b(agenda|agendar|programa|programar|cita|reunion|meeting|llamada)\b/.test(t)) {
    const when = t.match(
      /\b(hoy|ma[nñ]ana|pasado\s+ma[nñ]ana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|\d{1,2}\s*\/\s*\d{1,2}|a\s+las\s+\d{1,2}(?::\d{2})?|\d{1,2}\s*hs?)\b/
    );
    result.intent = 'schedule_event';
    result.data = {
      title: t,
      start_at: null,
      duration_minutes: 60,
      location: '',
      description: text,
    };
    if (when) result.data.when_text = when[0];
    result.response_text = when
      ? 'Entendido. Para confirmar la cita necesito la fecha y la hora exactas. Respondeme asi: "manana a las 15:00".'
      : 'Entendido. Indicame la fecha y la hora exacta y la agendo.';
    return result;
  }

  // --- Charla ---
  result.intent = 'chat';
  result.response_text =
    'Entendido. Ahora estoy en modo basico (sin IA configurada). Configura SPACE_BUNNY_API_KEY para habilitar la comprension completa.';
  return result;
}

// Space Bunny Alpha no devuelve una fecha ISO unificada: segun como este escrita la peticion usa un campo y un formato distintos.

const MESES = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9,
  noviembre: 10, diciembre: 11,
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

const DIAS_SEMANA = {
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4,
  viernes: 5, sabado: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4,
  friday: 5, saturday: 6,
};

/** Convierte a Date solo si es una fecha valida. */
function toValidDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Resuelve el texto de una hora ("15:00", "3pm", "15") a [hh, mm].
function parseTime(text) {
  if (!text) return null;
  const s = String(text).trim().toLowerCase();

  const ampm = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/);
  if (ampm) {
    let hh = Number(ampm[1]);
    const mm = ampm[2] ? Number(ampm[2]) : 0;
    const mer = ampm[3] || '';
    if (mer.startsWith('p') && hh < 12) hh += 12;
    if (mer.startsWith('a') && hh === 12) hh = 0;
    if (hh > 23 || mm > 59) return null;
    return [hh, mm];
  }

  const plain = s.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (plain) {
    const hh = Number(plain[1]);
    const mm = plain[2] ? Number(plain[2]) : 0;
    if (hh > 23 || mm > 59) return null;
    return [hh, mm];
  }
  return null;
}
// Resuelve la parte de fecha a un Date (medianoche local).
function parseDatePart(text) {
  if (!text) return null;
  const s = String(text).trim().toLowerCase();
  const now = new Date();

  // Relativas: hoy / manana / pasado manana.
  if (/^pasado\s+ma[nñ]ana$|^day\s+after\s+tomorrow$/.test(s)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 2);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (/^ma[nñ]ana$|^tomorrow$/.test(s)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (/^hoy$|^today$/.test(s)) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // ISO completo o solo la parte de fecha.
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[t ](\d{1,2}):(\d{2}))?/);
  if (iso) {
    return new Date(
      Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]),
      iso[4] ? Number(iso[4]) : 0, iso[5] ? Number(iso[5]) : 0
    );
  }

  // d/m/a o d-m/a (assume el anio actual si no viene).
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/);
  if (dmy) {
    let year = dmy[3] ? Number(dmy[3]) : now.getFullYear();
    if (year < 100) year += 2000;
    return new Date(year, Number(dmy[2]) - 1, Number(dmy[1]), 0, 0, 0);
  }

  // "3 de octubre" | "3 de octubre de 2026" | "12 de septiembre de 2026"
  const longMonth = s.match(/^(\d{1,2})\s+de\s+([a-z]+)(?:\s+de[l]?\s+(\d{4}))?$/);
  if (longMonth) {
    const month = MESES[longMonth[2]];
    if (month === undefined) return null;
    const year = longMonth[3] ? Number(longMonth[3]) : now.getFullYear();
    return new Date(year, month, Number(longMonth[1]), 0, 0, 0);
  }

  // "septiembre 12 de 2026" | "octubre 3"
  const monthDay = s.match(/^([a-z]+)\s+(\d{1,2})(?:\s+de[l]?\s+(\d{4}))?$/);
  if (monthDay) {
    const month = MESES[monthDay[1]];
    if (month === undefined) return null;
    const year = monthDay[3] ? Number(monthDay[3]) : now.getFullYear();
    return new Date(year, month, Number(monthDay[2]), 0, 0, 0);
  }

  // Solo nombre de dia: "viernes" -> el proximo de ese dia.
  if (DIAS_SEMANA[s] !== undefined) {
    const target = DIAS_SEMANA[s];
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    let delta = (target - d.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    d.setDate(d.getDate() + delta);
    return d;
  }

  return null;
}

// Normaliza los datos de un evento a un Date real.
function resolveEventDate(data) {
  if (!data) return null;

  // 1) El modelo ya dio una fecha completa utilizable.
  for (const key of ['start_at', 'startAt', 'start', 'when', 'datetime', 'date_time']) {
    const d = toValidDate(data[key]);
    if (d) return d;
  }

  // 2) date + time (el caso mas comun).
  const day = parseDatePart(data.date || data.day || data.dia);
  if (day) {
    const hm = parseTime(data.time || data.hora || data.hour);
    if (hm) {
      day.setHours(hm[0], hm[1], 0, 0);
      return day;
    }
    return day;
  }

  // 3) Solo weekday + time.
  if (data.weekday) {
    const d = parseDatePart(String(data.weekday).toLowerCase());
    const hm = parseTime(data.time || data.hora);
    if (d && hm) {
      d.setHours(hm[0], hm[1], 0, 0);
      return d;
    }
  }

  return null;
}

// El prompt le pide al modelo que use un texto exacto cuando faltan datos, pero los modelos no son deterministas.

/** Indica si un valor viene informado (no vacio, no null, no undefined). */
function informado(valor) {
  if (valor === null || valor === undefined) return false;
  const s = String(valor).trim();
  return s.length > 0 && s.toLowerCase() !== 'null' && s.toLowerCase() !== 'undefined';
}

// Revisa una intencion y, si faltan datos obligatorios, fuerza el mensaje predeterminado y marca la respuesta como incompleta.
function aplicarMensajesPredeterminados(result) {
  const { intent, data } = result;

  if (intent === 'schedule_event') {
    // La fecha se valida con resolveEventDate y no con un chequeo directo de
    // "start_at": el modelo suele devolverla partida en "date" + "time", y en
    // ese caso "start_at" queda en null aunque la fecha sí esté resuelta.
    const tieneFecha = Boolean(resolveEventDate(data));
    const completa =
      informado(data.title) && tieneFecha && informado(data.location);
    if (!completa) {
      result.response_text = MISSING_EVENT;
      result.faltan_datos = true;
    }
    return result;
  }

  if (intent === 'add_task') {
    // La fecha limite se valida con el mismo criterio: puede venir en
    // "due_at", "date" o "when".
    const tieneFecha = Boolean(
      resolveEventDate({ date: data.due_at }) || toValidDate(data.due_at)
    );
    const completa =
      informado(data.assignee) &&
      informado(data.title) &&
      informado(data.priority) &&
      informado(data.due_at);
    if (!completa || !tieneFecha) {
      result.response_text = MISSING_TASK;
      result.faltan_datos = true;
    }
    return result;
  }

  return result;
}

// Se declaran en formato OpenAI (function calling).

/** Herramientas disponibles para el modelo. */
const HERRAMIENTAS = [
  {
    type: 'function',
    function: {
      name: 'buscar_en_web',
      description:
        'Busca informacion actualizada en internet usando DuckDuckGo. ' +
        'Usala cuando necesites datos actuales, noticias, precios, o cuando ' +
        'no estes seguro de un dato. NO la uses paraOpinion, charla o para ' +
        'informacion que ya conocés con certeza.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'La consulta de busqueda. Debe ser concreta, en el idioma del ' +
              'usuario. Ej: "dolar blue paraguay hoy", "clima asuncion manana".',
          },
        },
        required: ['query'],
      },
    },
  },
];

/** Habilita o deshabilita la busqueda web. */
function webHabilitada() {
  return (process.env.WEB_SEARCH_ENABLED || 'true') === 'true';
}

// Ejecuta las herramientas que el modelo pidio y devuelve los mensajes con rol "tool" correspondientes.
async function ejecutarHerramientas(toolCalls, mensajeModelo) {
  const mensajes = [];
  let busquedas = 0;
  let errores = 0;

  for (const llamada of toolCalls) {
    const fn = llamada.function || {};
    const nombre = fn.name;
    const id = llamada.id || `call_${busquedas}`;

    if (nombre !== 'buscar_en_web') {
      // Herramienta desconocida: se informa para que el modelo continue.
      mensajes.push({
        role: 'tool',
        tool_call_id: id,
        content: `Herramienta desconocida: ${nombre}. Solo está disponible "buscar_en_web".`,
      });
      continue;
    }

    let consulta = '';
    try {
      const args = JSON.parse(fn.arguments || '{}');
      consulta = String(args.query || '').trim();
    } catch (_) {
      consulta = '';
    }

    if (!consulta) {
      mensajes.push({
        role: 'tool',
        tool_call_id: id,
        content: 'La consulta de búsqueda estaba vacía. Indicá qué querés buscar.',
      });
      continue;
    }

    busquedas += 1;
    console.log(`[ai] busqueda web: "${consulta}"`);

    try {
      const r = await web.buscar(consulta);
      if (r.ok) {
        mensajes.push({
          role: 'tool',
          tool_call_id: id,
          content: `Resultados de DuckDuckGo para "${consulta}":\n\n${web.formatearResultados(
            r.resultados
          )}`,
        });
      } else {
        errores += 1;
        // Se le pasa el error al modelo: lo menciona y responde sin inventar.
        mensajes.push({
          role: 'tool',
          tool_call_id: id,
          content: `La búsqueda de "${consulta}" falló: ${r.error} Respondé sin esos datos y no inventes información.`,
        });
      }
    } catch (err) {
      errores += 1;
      console.error(`[ai] fallo la búsqueda "${consulta}": ${err.message}`);
      mensajes.push({
        role: 'tool',
        tool_call_id: id,
        content: `Error inesperado al buscar "${consulta}": ${err.message}. Respondé sin esos datos.`,
      });
    }
  }

  return { mensajes, busquedas, errores };
}

// El bot llama a la IA una vez por mensaje de WhatsApp.

const stats = {
  llamadas: 0,
  ok: 0,
  errores: 0,
  tokensPrompt: 0,
  tokensCompletion: 0,
  desde: new Date().toISOString(),
};

/** Tope diario de llamadas. 0 = sin limite. */
function dailyCap() {
  return Number(process.env.SPACE_BUNNY_DAILY_CAP || 0);
}

/** Reinicia el contador si cambio el dia. */
function rolloverIfNeeded() {
  const hoy = new Date().toISOString().slice(0, 10);
  if (stats.desde.slice(0, 10) !== hoy) {
    stats.llamadas = 0;
    stats.ok = 0;
    stats.errores = 0;
    stats.tokensPrompt = 0;
    stats.tokensCompletion = 0;
    stats.desde = new Date().toISOString();
  }
}

// Snapshot del gasto, para el comando /estado y el endpoint de salud.
function getUsage() {
  rolloverIfNeeded();
  return {
    llamadas: stats.llamadas,
    ok: stats.ok,
    errores: stats.errores,
    tokens_prompt: stats.tokensPrompt,
    tokens_completion: stats.tokensCompletion,
    tokens_total: stats.tokensPrompt + stats.tokensCompletion,
    tope_diario: dailyCap(),
    desde: stats.desde,
  };
}

/** Registra el uso informado por la API. */
function recordUsage(usage) {
  if (!usage) return;
  stats.tokensPrompt += Number(usage.prompt_tokens || 0);
  stats.tokensCompletion += Number(usage.completion_tokens || 0);
}

// Normaliza un objeto arbitrario al contrato { intent, response_text, data }.
function normalize(raw) {
  const intent = INTENTS.includes(raw && raw.intent) ? raw.intent : 'chat';
  const responseText =
    (raw && (raw.response_text || raw.responseText)) || 'Listo.';

  let data = (raw && raw.data) || {};
  if (typeof data !== 'object' || Array.isArray(data) || data === null) {
    data = { value: data };
  }

  const out = { intent, response_text: String(responseText), data };
  if (raw && raw[MOCK_FLAG]) out.mock = true;
  return out;
}

// Extrae el primer objeto JSON balanceado de un texto que puede venir envuelto en ```json ...
function extractJson(text) {
  if (!text) return null;

  // 1) Bloque cercado por ``` si existe.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;

  try {
    return JSON.parse(candidate.trim());
  } catch (_) {
    /* se sigue con el metodo por barrido */
  }

  // 2) Barrido buscando el primer { ... } balanceado.
  const start = candidate.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch (_) {
          return null;
        }
      }
    }
  }
  return null;
}


// Envia el mega-prompt a Space Bunny Alpha y devuelve el JSON parseado.
async function route(userMessage, options = {}) {
  const {
    history = [],
    timezone = 'America/Asuncion',
    displayName = '',
  } = options;

  const apiKey = (process.env.SPACE_BUNNY_API_KEY || '').trim();
  // Si no se define la URL se usa el endpoint oficial. Asi, configurar solo la
  // clave alcanza para trabajar contra Space Bunny Alpha.
  const apiUrl = (
    process.env.SPACE_BUNNY_API_URL ||
    'https://spacebunnymodel.com/api/v1/chat/completions'
  ).trim();

  // --- Modo mock: sin clave configurada ---
  if (!apiKey) {
    return normalize(mockRoute(userMessage));
  }

  // --- Tope diario de llamadas: protege el gasto ---
  // Al alcanzar el tope, el bot responde con las reglas locales en vez de
  // llamar a la IA.
  rolloverIfNeeded();
  const cap = dailyCap();
  if (cap > 0 && stats.llamadas >= cap) {
    console.warn(
      `[ai] tope diario alcanzado (${cap} llamadas). Se responde con el modo local.`
    );
    return normalize(mockRoute(userMessage));
  }
  stats.llamadas += 1;

  const maxContext = Number(process.env.AI_CONTEXT_MESSAGES || 8);
  const context = history.slice(-maxContext).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || ''),
  }));

  // El prompt se construye en cada llamada para inyectar la fecha y hora
  // actuales: el modelo las necesita para resolver "mañana" o "el viernes".
  const systemContent = [
    buildSystemPrompt(),
    `Zona horaria del usuario: ${timezone}.`,
    displayName ? `Nombre del usuario: ${displayName}.` : '',
  ]
    .filter(Boolean)
    .join('\n');

  // Instruction base de la PRIMERA llamada. NO se fuerza JSON: el modelo
  // primero decide si necesita buscar. Si se fuerza el formato, no puede
  // pedir una herramienta.
  const instruccionBusqueda = [
    'Tenés acceso a internet mediante la herramienta "buscar_en_web" (DuckDuckGo).',
    'Usala SOLO si la pregunta requiere información actual o un dato que no',
    'puedés verificar con certeza (noticias, precios, clima, resultados).',
    'Si no la necesitás, respondé directamente.',
  ].join(' ');

  const messages = [
    { role: 'system', content: `${instruccionBusqueda}\n\n${systemContent}` },
    ...context,
    { role: 'user', content: String(userMessage || '') },
  ];

  const conHerramientas = webHabilitada();
  const timeoutMs = Number(process.env.SPACE_BUNNY_TIMEOUT_MS || 30000);

  /** Ejecuta una llamada a la API de Space Bunny Alpha. */
  const llamar = async (msgs, forzarJson) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const cuerpo = {
        model: process.env.SPACE_BUNNY_MODEL || 'space-bunny-alpha',
        messages: msgs,
        temperature: Number(process.env.SPACE_BUNNY_TEMPERATURE || 0.2),
        max_tokens: Number(process.env.SPACE_BUNNY_MAX_TOKENS || 4096),
      };
      // El formato JSON y las herramientas son excluyentes: el protocolo de
      // tool calling no admite forzar response_format y tools a la vez.
      if (forzarJson) cuerpo.response_format = { type: 'json_object' };
      if (conHerramientas && !forzarJson) cuerpo.tools = HERRAMIENTAS;

      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(cuerpo),
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Space Bunny ${res.status}: ${detail.slice(0, 200)}`);
      }
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  };

  try {
    // ===== PRIMERA LLAMADA: decidir si hace falta buscar =====
    const primera = await llamar(messages, false);
    recordUsage(primera.usage);

    const mensajeModelo =
      (primera.choices && primera.choices[0] && primera.choices[0].message) || {};
    const toolCalls = mensajeModelo.tool_calls || [];

    let contenido = mensajeModelo.content || '';
    let haySegundaLlamada = false;
    let mensajesFinales = null;

    if (toolCalls.length && conHerramientas) {
      // ===== EJECUCION DE LA BUSQUEDA (DuckDuckGo) =====
      const ejecucion = await ejecutarHerramientas(toolCalls, mensajeModelo);

      // ===== SEGUNDA LLAMADA: JSON estricto con el mega-prompt =====
      // Se reenvia el mensaje del modelo con sus tool_calls y luego los
      // resultados con rol "tool", como exige el protocolo de OpenAI.
      mensajesFinales = [
        messages[0],
        ...messages.slice(1),
        mensajeModelo,
        ...ejecucion.mensajes,
      ];
      haySegundaLlamada = true;
      contenido = '';
    } else {
      stats.llamadas += 1;
    }

    let payloadFinal = primera;
    if (haySegundaLlamada) {
      payloadFinal = await llamar(mensajesFinales, true);
      recordUsage(payloadFinal.usage);
      // La segunda llamada es la que produce la respuesta final: cuenta.
      stats.llamadas += 1;
      contenido =
        (payloadFinal.choices &&
          payloadFinal.choices[0] &&
          payloadFinal.choices[0].message &&
          payloadFinal.choices[0].message.content) ||
        '';
    }

    const parsed = extractJson(contenido);
    if (!parsed) {
      // Sin herramientas y sin JSON: se acepta como conversacion libre en
      // vez de romper el flujo.
      if (!toolCalls.length && contenido) {
        const libre = { intent: 'chat', response_text: contenido, data: {} };
        return aplicarMensajesPredeterminados(normalize(libre));
      }
      throw new Error('Space Bunny no devolvio JSON interpretable');
    }

    stats.ok += 1;

    // Si faltan datos, se impone el mensaje predeterminado exacto.
    return aplicarMensajesPredeterminados(normalize(parsed));
  } catch (err) {
    // Se degrada a mock: el bot nunca deja de responder.
    stats.errores += 1;
    const fallback = mockRoute(userMessage);
    fallback.fallback_reason = err.message;
    console.error(`[ai_router] fallo la llamada, uso mock: ${err.message}`);
    return normalize(fallback);
  }
}

module.exports = {
  route,
  normalize,
  extractJson,
  mockRoute,
  resolveEventDate,
  parseDatePart,
  parseTime,
  toValidDate,
  getUsage,
  buildSystemPrompt,
  momentoActual,
  aplicarMensajesPredeterminados,
  informado,
  HERRAMIENTAS,
  ejecutarHerramientas,
  webHabilitada,
  MISSING_EVENT,
  MISSING_TASK,
  INTENTS,
};
