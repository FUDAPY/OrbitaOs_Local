'use strict';
// OrbitaOs - mensajes programados.

const cron = require('node-cron');
const { ScheduledMessage, User } = require('./database');

const MINUTO = 60 * 1000;

/** Zona horaria por defecto, la misma que usa el resto del sistema. */
const ZONA = () => process.env.CRON_TZ || 'America/Asuncion';

/** Nombres cortos de dia que devuelve Intl en ingles, a indice 0-6. */
const INDICE_DIA = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Comprueba que una zona horaria exista.
function zonaValida(timeZone) {
  const zona = String(timeZone || '').trim() || ZONA();
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zona });
    return zona;
  } catch (_) {
    return ZONA();
  }
}

// Partes de una fecha vistas desde una zona horaria.
function partesEnZona(fecha, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: zonaValida(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });

  const p = {};
  for (const parte of fmt.formatToParts(fecha)) p[parte.type] = parte.value;

  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    // Algunas versiones de ICU devuelven "24" para la medianoche.
    hour: p.hour === '24' ? 0 : Number(p.hour),
    minute: Number(p.minute),
    weekday: INDICE_DIA[p.weekday] === undefined ? 0 : INDICE_DIA[p.weekday],
    // Clave del dia local: sirve para saber si ya se envio hoy.
    clave: `${p.year}-${p.month}-${p.day}`,
  };
}

// Diferencia, en minutos, entre la hora local de una zona y la hora UTC.
function desfaseMinutos(fecha, timeZone) {
  const zona = zonaValida(timeZone);
  const local = new Date(fecha.toLocaleString('en-US', { timeZone: zona }));
  const utc = new Date(fecha.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.round((local.getTime() - utc.getTime()) / MINUTO);
}

// Convierte una fecha local (year/month/day/hour/minute) al instante real.
function aInstante(partes, timeZone) {
  const comoUtc = Date.UTC(
    partes.year,
    partes.month - 1,
    partes.day,
    partes.hour,
    partes.minute,
    0,
    0
  );
  const desfase = desfaseMinutos(new Date(comoUtc), timeZone);
  return new Date(comoUtc - desfase * MINUTO);
}

// "HH:MM" a minutos desde la medianoche.
function timeEnMinutos(time) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(time || '09:00'));
  if (!m) return 9 * 60;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Indica si una fecha cae dentro de la regla de recurrencia del registro.
function coincide(doc, partes, weekday) {
  switch (doc.mode) {
    case 'daily':
      return true;
    case 'weekly':
      return weekday === doc.weekday;
    case 'monthly':
      return partes.day === doc.day;
    case 'yearly':
      return partes.month === doc.month && partes.day === doc.day;
    default:
      return false;
  }
}

/** Minutos desde la medianoche de una fecha vista en su zona. */
function minutosDelDia(partes) {
  return partes.hour * 60 + partes.minute;
}

// Proximo envio del registro, o null si ya no va a enviarse mas.
function calcularProximo(doc, ahora = new Date()) {
  if (doc.active === false) return null;

  // Un envio unico se calcula una sola vez.
  if (doc.mode === 'once') {
    if (doc.lastSentAt || !doc.runAt) return null;
    return new Date(doc.runAt);
  }

  const objetivo = timeEnMinutos(doc.time);
  const hoy = partesEnZona(ahora, doc.timezone);

  // Se busca dia por dia hasta algo mas de un ano: cubre el 29 de febrero, que
  // en un ano comun no existe y se corre al siguiente bisiesto.
  for (let i = 0; i < 400; i += 1) {
    const dia = new Date(Date.UTC(hoy.year, hoy.month - 1, hoy.day + i));
    const partes = {
      year: dia.getUTCFullYear(),
      month: dia.getUTCMonth() + 1,
      day: dia.getUTCDate(),
    };
    if (!coincide(doc, partes, dia.getUTCDay())) continue;

    const instante = aInstante(
      { ...partes, hour: Math.floor(objetivo / 60), minute: objetivo % 60 },
      doc.timezone
    );

    // Se tolera un minuto hacia atras para no saltar el dia cuando el ciclo
    // corre unos segundos despues de la hora exacta.
    if (instante.getTime() >= ahora.getTime() - MINUTO) return instante;
  }

  return null;
}

// Indica si a un registro le toca enviarse ahora.
function tocaAhora(doc, ahora = new Date()) {
  if (doc.active === false) return false;

  const partes = partesEnZona(ahora, doc.timezone);

  // Si el ultimo envio fue hoy (en la zona del registro), ya no se repite.
  if (
    doc.lastSentAt &&
    partesEnZona(new Date(doc.lastSentAt), doc.timezone).clave === partes.clave
  ) {
    return false;
  }

  if (doc.mode === 'once') {
    return Boolean(doc.runAt) && new Date(doc.runAt).getTime() <= ahora.getTime();
  }

  if (!coincide(doc, partes, partes.weekday)) return false;

  // Se usa >= y no ==: si el ciclo se saltea un minuto, el mensaje sale igual
  // un poco mas tarde en lugar de perderse hasta el ano siguiente.
  return minutosDelDia(partes) >= timeEnMinutos(doc.time);
}

// Reemplaza los marcadores del mensaje por los datos del contacto.
function formatearMensaje(doc, contacto) {
  const nombre = (contacto && (contacto.firstName || contacto.name)) || '';
  const apellido = (contacto && contacto.lastName) || '';
  const completo = [contacto && contacto.firstName, apellido]
    .filter(Boolean)
    .join(' ')
    .trim();

  return String(doc.body)
    .replace(/\{nombre_completo\}/gi, completo)
    .replace(/\{nombre\}/gi, nombre)
    .replace(/\{apellido\}/gi, apellido)
    .replace(/\{telefono\}/gi, doc.to);
}

// Envia los mensajes programados que ya vencieron su hora.
async function enviarPendientes(client, ahora = new Date()) {
  if (!client) return 0;

  let enviados = 0;

  try {
    const candidatos = await ScheduledMessage.find({ active: true }).lean();

    for (const doc of candidatos) {
      if (!tocaAhora(doc, ahora)) continue;

      try {
        // El nombre del contacto se usa para los marcadores {nombre} y demas.
        const contacto = await User.findOne({ phone: doc.to }).lean();

        await client.sendMessage(
          `${doc.to}@c.us`,
          formatearMensaje(doc, contacto)
        );

        const update = { $set: { lastSentAt: ahora }, $inc: { sentCount: 1 } };
        // Un envio unico se apaga solo despues de salir.
        if (doc.mode === 'once') update.$set.active = false;

        const marca = await ScheduledMessage.updateOne(
          { _id: doc._id, lastSentAt: doc.lastSentAt || null },
          update
        );

        if (marca.modifiedCount === 1) {
          enviados += 1;
          const etiqueta = doc.title || String(doc.body).slice(0, 40);
          console.log(`[programados] enviado a ${doc.to}: "${etiqueta}"`);
        }
      } catch (err) {
        console.error(`[programados] fallo al enviar a ${doc.to}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[programados] fallo consultando la agenda: ${err.message}`);
  }

  return enviados;
}

// Arranca el planificador de mensajes programados.
function startScheduledJob(client) {
  const pedido = process.env.CRON_SCHEDULED || '*/1 * * * *';
  const expresion = cron.validate(pedido) ? pedido : '*/1 * * * *';

  if (expresion !== pedido) {
    console.error(`[programados] expresion invalida "${pedido}", se usa "${expresion}"`);
  }

  const tarea = cron.schedule(
    expresion,
    async () => {
      // Un ciclo lento no debe solaparse con el siguiente.
      if (tarea.isBusy) return;
      try {
        await enviarPendientes(client);
      } catch (err) {
        console.error(`[programados] error en el ciclo: ${err.message}`);
      }
    },
    {
      scheduled: true,
      timezone: process.env.CRON_TZ || 'America/Asuncion',
    }
  );

  console.log(`[programados] motor de mensajes activo ("${expresion}")`);
  return tarea;
}

/** Detiene el planificador. */
function stopScheduledJob(tarea) {
  if (tarea) tarea.stop();
}

module.exports = {
  zonaValida,
  partesEnZona,
  desfaseMinutos,
  aInstante,
  timeEnMinutos,
  coincide,
  calcularProximo,
  tocaAhora,
  formatearMensaje,
  enviarPendientes,
  startScheduledJob,
  stopScheduledJob,
};
