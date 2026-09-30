'use strict';
// OrbitaOs - motor de recordatorios.

const cron = require('node-cron');
const { Event } = require('./database');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Hitos soportados, en horas antes del evento. */
const HITO_24H = 24;
const HITO_2H = 2;

// Construye la ventana temporal para un hito dado.
function buildWindow(targetHoursBefore, now, toleranceMinutes) {
  const tolerance = toleranceMinutes * MINUTE;
  const delta = targetHoursBefore * HOUR;
  return {
    min: new Date(now.getTime() + delta - tolerance),
    max: new Date(now.getTime() + delta + tolerance),
  };
}

// Formatea una fecha con la zona horaria configurada.
function formatDate(date) {
  try {
    return new Intl.DateTimeFormat('es-AR', {
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: process.env.REMINDER_TIMEZONE || 'America/Asuncion',
    }).format(date);
  } catch (_) {
    return date.toISOString();
  }
}

// Arma el texto del recordatorio.
function buildReminderText(event, hoursBefore) {
  const when = formatDate(event.startAt);
  const head =
    hoursBefore === HITO_24H
      ? '⏰ *Recordatorio 24 horas*'
      : '🔔 *Recordatorio 2 horas*';

  const lines = [head, '', `*${event.title}*`, `🗓 ${when}`];

  if (event.endAt) {
    lines.push(`⏳ Fin estimado: ${formatDate(event.endAt)}`);
  }
  if (event.location) lines.push(`📍 ${event.location}`);
  if (event.description) lines.push('', `_${event.description}_`);

  lines.push(
    '',
    hoursBefore === HITO_24H
      ? 'Respondé *ok* para confirmar o *cancelar* para dar de baja la cita.'
      : 'Vas con tiempo. Mandá *ok* para confirmar o *cancelar* para dar de baja.'
  );

  return lines.join('\n');
}

// Envia los recordatorios de un hito.
async function sendRemindersFor(hoursBefore, client) {
  if (!client) return 0;

  const now = new Date();
  const tolerance = Number(process.env.REMINDER_TOLERANCE_MINUTES || 10);
  const { min, max } = buildWindow(hoursBefore, now, tolerance);
  const field = hoursBefore === HITO_24H ? 'h24' : 'h2';

  let sent = 0;

  try {
    // Solo eventos confirmados, futuros y con la marca de envio pendiente.
    const events = await Event.find({
      [`reminders.${field}.sent`]: false,
      status: 'confirmed',
      startAt: { $gte: min, $lte: max, $gt: now },
    }).lean();

    for (const event of events) {
      try {
        await client.sendMessage(
          `${event.owner}@c.us`,
          buildReminderText(event, hoursBefore)
        );

        // Marca el envio por _id + estado: no pisa un envio concurrente
        // hecho por otra instancia del cron.
        const updated = await Event.updateOne(
          { _id: event._id, [`reminders.${field}.sent`]: false },
          { $set: { [`reminders.${field}.sent`]: true, [`reminders.${field}.sentAt`]: now } }
        );

        if (updated.modifiedCount === 1) {
          sent += 1;
          console.log(
            `[cron] recordatorio ${hoursBefore}h enviado a ${event.owner} para "${event.title}"`
          );
        }
      } catch (err) {
        console.error(`[cron] fallo al enviar recordatorio ${hoursBefore}h: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[cron] fallo consultando recordatorios ${hoursBefore}h: ${err.message}`);
  }

  return sent;
}

// Ciclo completo: procesa los dos hitos en el mismo tick.
async function runReminderCycle(client) {
  const t24 = await sendRemindersFor(HITO_24H, client);
  const t2 = await sendRemindersFor(HITO_2H, client);
  if (t24 || t2) console.log(`[cron] ciclo completado: ${t24} x 24h, ${t2} x 2h`);
}

// Marca como completados los eventos cuya hora de fin ya paso.
async function markPastEventsDone() {
  try {
    const res = await Event.updateMany(
      { status: 'confirmed', endAt: { $ne: null, $lte: new Date() } },
      { $set: { status: 'done' } }
    );
    if (res.modifiedCount) {
      console.log(`[cron] ${res.modifiedCount} evento(s) marcados como completados`);
    }
    return res.modifiedCount || 0;
  } catch (err) {
    console.error(`[cron] fallo al cerrar eventos pasados: ${err.message}`);
    return 0;
  }
}

// Arranca el planificador de recordatorios.
function startReminderJobs(client) {
  const requested = process.env.CRON_REMINDERS || '*/1 * * * *';
  const expression = cron.validate(requested) ? requested : '*/1 * * * *';

  if (expression !== requested) {
    console.error(`[cron] expresion invalida "${requested}", se usa "${expression}"`);
  }

  const task = cron.schedule(
    expression,
    async () => {
      // Un ciclo lento no debe solaparse con el siguiente.
      if (task.isBusy) return;
      try {
        await markPastEventsDone();
        await runReminderCycle(client);
      } catch (err) {
        console.error(`[cron] error en el ciclo: ${err.message}`);
      }
    },
    {
      scheduled: true,
      timezone: process.env.CRON_TZ || 'America/Asuncion',
    }
  );

  console.log(
    `[cron] motor de recordatorios activo ("${expression}", tz=${process.env.CRON_TZ || 'America/Asuncion'})`
  );
  return task;
}

/** Detiene el planificador. */
function stopReminderJobs(task) {
  if (task) task.stop();
}

module.exports = {
  startReminderJobs,
  stopReminderJobs,
  runReminderCycle,
  sendRemindersFor,
  buildReminderText,
  buildWindow,
  formatDate,
  markPastEventsDone,
  HITO_24H,
  HITO_2H,
};

