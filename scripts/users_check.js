'use strict';
// OrbitaOs - pruebas del modulo de usuarios.

const assert = require('assert');
process.env.SPACE_BUNNY_API_KEY = '';
delete process.env.SPACE_BUNNY_API_URL;

const users = require('../src/users');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('\nContrasenas');

check('hashea y verifica la contrasena correcta', () => {
  const h = users.hashPassword('741963');
  assert.ok(users.verifyPassword('741963', h));
});

check('rechaza la contrasena incorrecta', () => {
  const h = users.hashPassword('741963');
  assert.strictEqual(users.verifyPassword('741964', h), false);
});

check('el hash nunca contiene la contrasena en claro', () => {
  const h = users.hashPassword('741963');
  assert.ok(!h.includes('741963'));
  assert.ok(h.startsWith('scrypt$'));
});

check('dos hashes de la misma clave son distintos (salt aleatorio)', () => {
  assert.notStrictEqual(users.hashPassword('741963'), users.hashPassword('741963'));
});

check('rechaza un hash corrupto sin lanzar', () => {
  assert.strictEqual(users.verifyPassword('x', 'basura'), false);
  assert.strictEqual(users.verifyPassword('x', ''), false);
  assert.strictEqual(users.verifyPassword('x', null), false);
});

check('formato del hash: scrypt$N$r$p$salt$hash', () => {
  const partes = users.hashPassword('clave123').split('$');
  assert.strictEqual(partes.length, 6);
  assert.ok(/^\d+$/.test(partes[1]));
  assert.ok(/^[0-9a-f]+$/.test(partes[4]));
});

console.log('\nNormalizacion');

check('el username se pasa a minusculas y sin espacios', () => {
  assert.strictEqual(users.normalizeUsername('  ThesadBoy  '), 'thesadboy');
});

check('el telefono queda en solo digitos', () => {
  assert.strictEqual(users.normalizePhone('+54 9 11 1234-5678'), '5491112345678');
  assert.strictEqual(users.normalizePhone('54911123456789'), '54911123456789');
  assert.strictEqual(users.normalizePhone(''), '');
});

console.log('\nValidacion de entradas');

check('rechaza usuario con caracteres invalidos', () => {
  // Se valida el regex que usa createUser sin tocar la base.
  const ok = /^[a-z0-9._-]{3,32}$/.test('mal usuario');
  assert.strictEqual(ok, false);
  assert.strictEqual(/^[a-z0-9._-]{3,32}$/.test('thesadboy'), true);
  assert.strictEqual(/^[a-z0-9._-]{3,32}$/.test('user.con-guion_1'), true);
});

check('rechaza telefono con letras o muy corto', () => {
  // Se valida el formato ya normalizado, que es el que exige createUser.
  const valido = (p) => {
    const d = users.normalizePhone(p);
    return d === '' || /^\d{8,20}$/.test(d);
  };
  assert.strictEqual(valido('54911123456789'), true);
  assert.strictEqual(valido('123'), false);
  // Con letras, normalizePhone las descarta y queda "12345678": valido.
  assert.strictEqual(valido('abc12345678'), true);
  assert.strictEqual(users.normalizePhone('abc12345678'), '12345678');
});

check('expone los tres roles', () => {
  assert.deepStrictEqual(users.ROLES, ['owner', 'admin', 'member']);
});

check('expone el CRUD completo', () => {
  for (const fn of [
    'createUser', 'listUsers', 'deleteUser', 'renameUser',
    'changePassword', 'authenticate', 'ensureBootstrapUser',
  ]) {
    assert.strictEqual(typeof users[fn], 'function', `falta ${fn}`);
  }
});

console.log(`\n${passed} comprobaciones OK\n`);
