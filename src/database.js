'use strict';
// OrbitaOs - capa de datos.

const mongoose = require('mongoose');

const SCHEMA_OPTIONS = {
  timestamps: true,
  versionKey: false,
  strict: true,
};

/* -------------------------------------------------------------------------
 * Subesquema de marca de recordatorio: { sent, sentAt }.
 * Se declara antes de los esquemas que lo usan.
 * ---------------------------------------------------------------------- */
function reminderMarkSchema() {
  return new mongoose.Schema(
    {
      sent: { type: Boolean, default: false },
      sentAt: { type: Date, default: null },
    },
    { _id: false }
  );
}

// User: identidad del sistema.
const userSchema = new mongoose.Schema(
  {
    // Identificador unico de acceso. Normalizado en minusculas.
    username: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
      lowercase: true,
      minlength: 3,
      maxlength: 32,
    },
    // Hash scrypt. NUNCA se devuelve en las respuestas de la API.
    passwordHash: { type: String, required: true, select: false },
    // Nombre visible, editable.
    name: { type: String, default: '', trim: true, maxlength: 80 },
    // Nombre y apellido por separado: permiten ordenar la agenda por apellido
    // y armar el saludo de los mensajes programados ("Hola Ana").
    firstName: { type: String, default: '', trim: true, maxlength: 60 },
    lastName: { type: String, default: '', trim: true, maxlength: 60 },
    // Fecha de nacimiento del contacto. Se usa para los saludos anuales.
    birthday: { type: Date, default: null },
    // Telefono en formato internacional solo digitos: 54911123456789
    // Opcional: un usuario puede existir sin numero de WhatsApp.
    phone: {
      type: String,
      default: null,
      unique: true,
      sparse: true,
      trim: true,
    },
    // Rol para futuras extensiones: owner | admin | member
    role: {
      type: String,
      enum: ['owner', 'admin', 'member'],
      default: 'member',
    },
    // Si el usuario esta habilitado en la lista blanca de WhatsApp.
    allowed: { type: Boolean, default: true },
    // Zona horaria IANA para interpretar y mostrar las fechas.
    timezone: {
      type: String,
      default: 'America/Asuncion',
    },
    language: { type: String, default: 'es' },
    notes: { type: String, default: '' },
    lastSeenAt: { type: Date, default: null },
  },
  SCHEMA_OPTIONS
);

// Consulta de la lista blanca: telefono + permiso.
userSchema.index({ phone: 1, allowed: 1 });


/* -------------------------------------------------------------------------
 * Message: bitacora completa de la conversacion (entrante y saliente).
 * ---------------------------------------------------------------------- */
const messageSchema = new mongoose.Schema(
  {
    // Identificador del chat. En privado coincide con el telefono.
    chatId: { type: String, required: true, index: true },
    from: { type: String, required: true, index: true },
    to: { type: String, required: true },
    // inbound = lo escribe el usuario, outbound = lo responde el bot.
    direction: {
      type: String,
      enum: ['inbound', 'outbound'],
      required: true,
    },
    body: { type: String, required: true },
    // Intencion detectada por la IA. Null en mensajes de entrada crudos.
    intent: { type: String, default: null, index: true },
    // Datos estructurados que devolvio la IA para esa intencion.
    data: { type: mongoose.Schema.Types.Mixed, default: null },
    // true si la IA no pudo responder y se aplico el fallback.
    fallback: { type: Boolean, default: false },
    isGroup: { type: Boolean, default: false },
    // Id de Mongo del mensaje de WhatsApp, util para deduplicar.
    whatsappMessageId: { type: String, default: null, index: true, sparse: true },
  },
  SCHEMA_OPTIONS
);

// Consulta principal: historial de un chat, del mas nuevo al mas viejo.
messageSchema.index({ chatId: 1, createdAt: -1 });


/* -------------------------------------------------------------------------
 * Event: cita/reunion con recordatorios 24h y 2h.
 * ---------------------------------------------------------------------- */
const eventSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    // Quien es dueno del evento (telefono).
    owner: { type: String, required: true, index: true },
    // Quien lo creo, por si un admin agenda para otra persona.
    createdBy: { type: String, required: true },
    chatId: { type: String, required: true, index: true },
    startAt: { type: Date, required: true, index: true },
    endAt: { type: Date, default: null },
    location: { type: String, default: '' },
    // Estado: confirmed | cancelled | done
    status: {
      type: String,
      enum: ['confirmed', 'cancelled', 'done'],
      default: 'confirmed',
    },
    // Marcas de envio de los recordatorios, una por hito (24h y 2h).
    reminders: {
      h24: { type: reminderMarkSchema(), default: () => ({ sent: false, sentAt: null }) },
      h2: { type: reminderMarkSchema(), default: () => ({ sent: false, sentAt: null }) },
    },
    source: { type: String, default: 'ai' },
  },
  SCHEMA_OPTIONS
);

// El cron busca por ventana temporal y por recordatorio pendiente.
eventSchema.index({ 'reminders.h24.sent': 1, startAt: 1 });
eventSchema.index({ 'reminders.h2.sent': 1, startAt: 1 });

/* -------------------------------------------------------------------------
 * Task: tarea del pipeline / Kanban.
 * ---------------------------------------------------------------------- */
const taskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    owner: { type: String, required: true, index: true },
    createdBy: { type: String, required: true },
    chatId: { type: String, required: true, index: true },
    // Columnas del Kanban.
    status: {
      type: String,
      enum: ['backlog', 'todo', 'in_progress', 'review', 'done'],
      default: 'todo',
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'urgent'],
      default: 'medium',
    },
    dueAt: { type: Date, default: null },
    // Orden dentro de la columna, para ordenar el tablero.
    position: { type: Number, default: 0 },
    // Etiquetas libres para segmentar el trabajo.
    labels: { type: [String], default: [] },
    source: { type: String, default: 'ai' },
  },
  SCHEMA_OPTIONS
);

taskSchema.index({ owner: 1, status: 1, position: 1 });

// ScheduledMessage: mensaje que el bot envia solo, en una fecha dada.
const scheduledMessageSchema = new mongoose.Schema(
  {
    // Telefono destinatario, solo digitos.
    to: { type: String, required: true, index: true },
    chatId: { type: String, required: true, index: true },
    // Texto que se envia. Admite {nombre} y {apellido}.
    body: { type: String, required: true, trim: true, maxlength: 4000 },
    // Titulo corto para reconocerlo en el panel.
    title: { type: String, default: '', trim: true, maxlength: 120 },
    mode: {
      type: String,
      enum: ['once', 'yearly', 'monthly', 'weekly', 'daily'],
      default: 'once',
    },
    runAt: { type: Date, default: null },
    month: { type: Number, default: null, min: 1, max: 12 },
    day: { type: Number, default: null, min: 1, max: 31 },
    weekday: { type: Number, default: null, min: 0, max: 6 },
    // Hora local en formato HH:MM.
    time: { type: String, default: '09:00' },
    timezone: { type: String, default: 'America/Asuncion' },
    active: { type: Boolean, default: true },
    // Ultimo envio, para no repetir el mismo dia si el cron corre varias veces.
    lastSentAt: { type: Date, default: null },
    // Cantidad de envios, util para auditar.
    sentCount: { type: Number, default: 0 },
    owner: { type: String, required: true, index: true },
    createdBy: { type: String, required: true },
    source: { type: String, default: 'panel' },
  },
  SCHEMA_OPTIONS
);

// El cron busca por activo y por lo que ya se envio.
scheduledMessageSchema.index({ active: 1, lastSentAt: 1 });

/* -------------------------------------------------------------------------
 * Modelos
 * ---------------------------------------------------------------------- */
const User = mongoose.models.User || mongoose.model('User', userSchema);
const Message = mongoose.models.Message || mongoose.model('Message', messageSchema);
const Event = mongoose.models.Event || mongoose.model('Event', eventSchema);
const Task = mongoose.models.Task || mongoose.model('Task', taskSchema);
const ScheduledMessage =
  mongoose.models.ScheduledMessage ||
  mongoose.model('ScheduledMessage', scheduledMessageSchema);

// Conecta con MongoDB.
async function connect(uri) {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, {
    maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 10),
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    autoIndex: true,
  });
  return mongoose;
}

/** Cierra la conexion de forma ordenada. */
async function disconnect() {
  await mongoose.connection.close();
}

module.exports = {
  connect,
  disconnect,
  mongoose,
  User,
  Message,
  Event,
  Task,
  ScheduledMessage,
};
