'use strict';
// OrbitaOs - pruebas del normalizador de fechas.

const assert = require('assert');
const ai = require('../src/ai_router');

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

/** Formato legible para comparar: YYYY-MM-DD HH:MM en hora local. */
function stamp(d) {
  if (!d) return 'null';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Devuelve la fecha de manana en ISO corto, para aserciones. */
function manana() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

console.log('\nFormatos reales devueltos por Space Bunny Alpha');

check('case 1: date "tomorrow" + time "15:00"', () => {
  const d = ai.resolveEventDate({ date: 'tomorrow', time: '15:00' });
  assert.strictEqual(stamp(d), `${manana()} 15:00`);
});

check('case 2: date ISO "2026-09-12" + time "10:30"', () => {
  const d = ai.resolveEventDate({ date: '2026-09-12', time: '10:30' });
  assert.strictEqual(stamp(d), '2026-09-12 10:30');
});

check('case 3: date "3 de octubre" + time "18:00" (ignora el weekday)', () => {
  const d = ai.resolveEventDate({
    date: '3 de octubre', time: '18:00', weekday: 'viernes',
  });
  assert.strictEqual(stamp(d), `${new Date().getFullYear()}-10-03 18:00`);
});

check('case 4: campo "start" con ISO completo (sin date)', () => {
  const d = ai.resolveEventDate({ start: '2026-10-05T14:00:00Z' });
  assert.ok(d instanceof Date);
  assert.strictEqual(d.toISOString(), '2026-10-05T14:00:00.000Z');
});

console.log('\nOtros formatos de fecha');

check('formato d/m/aaaa con año de 2 digitos', () => {
  const d = ai.resolveEventDate({ date: '12/09/26', time: '09:00' });
  assert.strictEqual(stamp(d), '2026-09-12 09:00');
});

check('solo "hoy" sin hora', () => {
  const d = ai.resolveEventDate({ date: 'hoy' });
  assert.ok(d instanceof Date);
  assert.strictEqual(d.getHours(), 0);
});

check('"pasado mañana" con hora', () => {
  const d = ai.resolveEventDate({ date: 'pasado mañana', time: '12:00' });
  const esperado = new Date();
  esperado.setDate(esperado.getDate() + 2);
  assert.strictEqual(d.getDate(), esperado.getDate());
  assert.strictEqual(d.getHours(), 12);
});

check('solo weekday "viernes" + hora 17:00', () => {
  const d = ai.resolveEventDate({ weekday: 'viernes', time: '17:00' });
  assert.ok(d instanceof Date);
  assert.strictEqual(d.getDay(), 5, 'debe caer en viernes');
  assert.strictEqual(d.getHours(), 17);
});

check('"12 de septiembre de 2026" con año (formato de la API real)', () => {
  const d = ai.resolveEventDate({
    date: '12 de septiembre de 2026', time: '10:30',
  });
  assert.strictEqual(stamp(d), '2026-09-12 10:30');
});

check('"3 de octubre" con año explícito', () => {
  const d = ai.resolveEventDate({ date: '3 de octubre de 2026', time: '18:00' });
  assert.strictEqual(stamp(d), '2026-10-03 18:00');
});

check('"octubre 3 de 2026" (mes primero)', () => {
  const d = ai.resolveEventDate({ date: 'octubre 3 de 2026', time: '08:00' });
  assert.strictEqual(stamp(d), '2026-10-03 08:00');
});

check('hora en formato 12h "3pm" -> 15:00', () => {
  const d = ai.resolveEventDate({ date: '2026-09-12', time: '3pm' });
  assert.strictEqual(d.getHours(), 15);
});

check('hora en formato 12h "12am" -> 00:00', () => {
  assert.deepStrictEqual(ai.parseTime('12am'), [0, 0]);
});

check('ISO con Z en start_at', () => {
  const d = ai.resolveEventDate({ start_at: '2026-11-20T09:00:00Z' });
  assert.strictEqual(d.toISOString(), '2026-11-20T09:00:00.000Z');
});

console.log('\nCasos que deben fallar limpio');

check('data sin ningun dato de fecha devuelve null', () => {
  assert.strictEqual(ai.resolveEventDate({}), null);
});

check('data undefined devuelve null', () => {
  assert.strictEqual(ai.resolveEventDate(undefined), null);
});

check('mes inexistente devuelve null', () => {
  assert.strictEqual(ai.resolveEventDate({ date: '3 de，迅速diciembre' }), null);
});

check('hora invalida devuelve null', () => {
  assert.deepStrictEqual(ai.parseTime('99:99'), null);
  assert.deepStrictEqual(ai.parseTime('noche'), null);
});

check('texto libre devuelve null', () => {
  assert.strictEqual(ai.parseDatePart('cuando puedas'), null);
});

check('toValidDate rechaza basura', () => {
  assert.strictEqual(ai.toValidDate('no es fecha'), null);
  assert.strictEqual(ai.toValidDate(''), null);
  assert.strictEqual(ai.toValidDate(null), null);
});

console.log(`\n${passed} comprobaciones OK\n`);
