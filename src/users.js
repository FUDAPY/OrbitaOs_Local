'use strict';
// OrbitaOs - modulo de gestion de usuarios.

const crypto = require('crypto');
const { User } = require('./database');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, saltlen: 16 };
const ROLES = ['owner', 'admin', 'member'];

/* -------------------------------------------------------------------------
 * Contrasenas
 * ---------------------------------------------------------------------- */

// Hashea una contrasena con scrypt y un salt aleatorio.
function hashPassword(password) {
  const salt = crypto.randomBytes(SCRYPT.saltlen);
  const hash = crypto.scryptSync(
    String(password),
    salt,
    SCRYPT.keylen,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }
  );
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('hex'),
    hash.toString('hex'),
  ].join('$');
}

// Verifica una contrasena contra un hash almacenado, en tiempo constante.
function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'hex');
  const expected = Buffer.from(parts[5], 'hex');

  let actual;
  try {
    actual = crypto.scryptSync(String(password), salt, expected.length, { N, r, p });
  } catch (_) {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Proyeccion segura: nunca devuelve el hash. */
function sanitize(user) {
  if (!user) return null;
  const u = user.toObject ? user.toObject() : user;
  delete u.passwordHash;
  delete u.__v;
  return u;
}

/* -------------------------------------------------------------------------
 * CRUD
 * ---------------------------------------------------------------------- */

// Normaliza un nombre de usuario: sin espacios, en minusculas.
function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

// Normaliza un telefono a solo digitos.
function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

// Crea un usuario.
async function createUser(data) {
  const username = normalizeUsername(data.username);
  const password = String(data.password || '');

  if (!username) throw new Error('El nombre de usuario es obligatorio');
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    throw new Error(
      'Nombre de usuario invalido: 3 a 32 caracteres, solo letras, numeros, punto, guion y guion bajo'
    );
  }
  if (password.length < 6) {
    throw new Error('La contrasena debe tener al menos 6 caracteres');
  }

  const phone = normalizePhone(data.phone);
  if (phone && !/^\d{8,20}$/.test(phone)) {
    throw new Error('Telefono invalido: debe tener entre 8 y 20 digitos');
  }

  const role = ROLES.includes(data.role) ? data.role : 'member';

  // El username debe ser unico a nivel de base, no solo por indice.
  if (await User.findOne({ username }).lean()) {
    throw new Error(`El usuario "${username}" ya existe`);
  }
  if (phone && (await User.findOne({ phone }).lean())) {
    throw new Error(`El telefono ${phone} ya esta asociado a otro usuario`);
  }

  const user = await User.create({
    username,
    passwordHash: hashPassword(password),
    // Si no se informa un nombre visible, se compone con nombre y apellido.
    name: (
      data.name ||
      [data.firstName, data.lastName].filter(Boolean).join(' ') ||
      username
    ).trim(),
    firstName: String(data.firstName || '').trim(),
    lastName: String(data.lastName || '').trim(),
    birthday: data.birthday ? new Date(data.birthday) : null,
    phone: phone || null,
    role,
    allowed: data.allowed !== false,
    timezone: data.timezone || 'America/Asuncion',
  });

  return sanitize(user);
}

// Lista todos los usuarios, sin hashes.
async function listUsers() {
  const users = await User.find({}).sort({ createdAt: 1 }).lean();
  return users.map((u) => {
    const { passwordHash, __v, ...rest } = u;
    return rest;
  });
}

// Busca un usuario por nombre de usuario.
async function findByUsername(username) {
  return User.findOne({ username: normalizeUsername(username) });
}

// Renombra un usuario (cambia su nombre visible).
async function renameUser(username, newName) {
  const name = String(newName || '').trim();
  if (!name) throw new Error('El nombre no puede estar vacio');
  if (name.length > 80) throw new Error('El nombre es demasiado largo');

  const user = await User.findOneAndUpdate(
    { username: normalizeUsername(username) },
    { $set: { name } },
    { new: true }
  );
  if (!user) throw new Error(`No existe el usuario "${username}"`);
  return sanitize(user);
}

// Cambia la contrasena de un usuario.
async function changePassword(username, newPassword) {
  const password = String(newPassword || '');
  if (password.length < 6) {
    throw new Error('La contrasena debe tener al menos 6 caracteres');
  }

  const user = await User.findOneAndUpdate(
    { username: normalizeUsername(username) },
    { $set: { passwordHash: hashPassword(password) } },
    { new: true }
  );
  if (!user) throw new Error(`No existe el usuario "${username}"`);
  return sanitize(user);
}

// Elimina un usuario.
async function deleteUser(username, options = {}) {
  const target = normalizeUsername(username);
  const user = await User.findOne({ username: target });
  if (!user) throw new Error(`No existe el usuario "${username}"`);

  if (user.role === 'owner' && !options.force) {
    const owners = await User.countDocuments({ role: 'owner' });
    if (owners <= 1) {
      throw new Error(
        'No se puede eliminar al unico owner. Crea otro owner primero o usa force.'
      );
    }
  }

  await User.deleteOne({ username: target });
  return { username: target };
}

// Autentica a un usuario verificando su contrasena.
async function authenticate(username, password) {
  const user = await findByUsername(username);
  // Se verifica siempre contra un hash, exista o no el usuario, para no
  // filtrar por tiempo de respuesta si el nombre es valido.
  const stored = user && user.passwordHash;
  const ok = verifyPassword(password, stored);
  if (!user || !ok || !stored) return null;
  return sanitize(user);
}

// Crea el primer usuario del sistema si la coleccion esta vacia.
async function ensureBootstrapUser() {
  const count = await User.countDocuments();
  if (count > 0) {
    const first = await User.findOne().sort({ createdAt: 1 }).lean();
    return { created: false, username: first && first.username };
  }

  const username = normalizeUsername(
    process.env.ADMIN_USERNAME || process.env.ADMIN_USER || ''
  );
  const password = process.env.ADMIN_PASSWORD || '';

  if (!username || !password) {
    throw new Error(
      'No hay usuarios en la base. Define ADMIN_USERNAME y ADMIN_PASSWORD para crear el primero.'
    );
  }

  await createUser({
    username,
    password,
    name: process.env.ADMIN_NAME || username,
    role: 'owner',
    phone: normalizePhone(process.env.ADMIN_PHONE),
    allowed: true,
  });

  return { created: true, username };
}

/* -------------------------------------------------------------------------
 * Lista blanca derivada de la base
 * ---------------------------------------------------------------------- */

// Indica si un telefono puede hablar con el bot.
async function isAllowedPhone(phone) {
  const clean = normalizePhone(phone);
  if (!clean) return false;

  const user = await User.findOne({ phone: clean, allowed: true }).lean();
  if (user) return true;

  const fromEnv = (process.env.WHITELIST || '')
    .split(',')
    .map((p) => p.replace(/\D/g, ''))
    .filter(Boolean);
  return fromEnv.includes(clean);
}

// Devuelve el usuario registrado para un telefono, si existe.
async function findByPhone(phone) {
  return User.findOne({ phone: normalizePhone(phone) }).lean();
}

module.exports = {
  createUser,
  listUsers,
  deleteUser,
  renameUser,
  changePassword,
  authenticate,
  findByUsername,
  findByPhone,
  ensureBootstrapUser,
  isAllowedPhone,
  hashPassword,
  verifyPassword,
  normalizeUsername,
  normalizePhone,
  ROLES,
};


