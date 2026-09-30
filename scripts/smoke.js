'use strict';
// OrbitaOs - smoke test sin conexion a WhatsApp ni a MongoDB.

// Sin claves: fuerza el modo mock de la IA.
delete process.env.SPACE_BUNNY_API_KEY;
delete process.env.SPACE_BUNNY_API_URL;

const assert = require('assert');
const ai = require('../src/ai_router');
const cron = require('../src/cron_jobs');

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

console.log('\nai_router');

check('extrae JSON plano', () => {
  const r = ai.extractJson('{"intent":"chat","response_text":"hola","data":{}}');
  assert.strictEqual(r.intent, 'chat');
});

check('extrae JSON dentro de bloque cercado', () => {
  const raw = '```json\n{"intent":"add_task","response_text":"ok","data":{"title":"x"}}\n```';
  const r = ai.extractJson(raw);
  assert.strictEqual(r.intent, 'add_task');
  assert.strictEqual(r.data.title, 'x');
});

check('extrae JSON con texto alrededor', () => {
  const r = ai.extractJson('Aqui tienes: {"intent":"chat","response_text":"listo","data":{}}fin');
  assert.strictEqual(r.response_text, 'listo');
});

check('normaliza una intencion invalida a chat', () => {
  const r = ai.normalize({ intent: 'inventada', response_text: 'hola' });
  assert.strictEqual(r.intent, 'chat');
});

check('normaliza data no-objeto', () => {
  const r = ai.normalize({ intent: 'chat', response_text: 'x', data: 'texto' });
  assert.strictEqual(typeof r.data, 'object');
});

console.log('\nai_router.route (modo mock)');

(async () => {
  const cases = [
    ['Agenda una reunion mañana a las 15:00', 'schedule_event'],
    ['Crear una tarea urgente: llamar al proveedor', 'add_task'],
    ['Completar la tarea de llamar al proveedor', 'update_task'],
    ['Redacta un acta de la reunion', 'create_document'],
    ['Hola, como estas?', 'chat'],
  ];

  for (const [message, expected] of cases) {
    const result = await ai.route(message, { history: [], timezone: 'America/Argentina/Buenos_Aires' });
    const ok = result.intent === expected;
    passed += ok ? 1 : 0;
    if (ok) {
      console.log(`  ok  "${message.slice(0, 38)}" -> ${result.intent}`);
    } else {
      console.error(`  FAIL "${message.slice(0, 38)}" -> ${result.intent} (esperado ${expected})`);
      process.exitCode = 1;
    }
  }

  console.log('\ncron_jobs');

  const now = new Date('2026-09-12T12:00:00.000Z');
  const w24 = cron.buildWindow(24, now, 10);
  assert.strictEqual(w24.max.getTime() - w24.min.getTime(), 20 * 60 * 1000);
  console.log('  ok  ventana de 24h +/- tolerancia');
  passed += 1;

  const w2 = cron.buildWindow(2, now, 10);
  assert.strictEqual(w2.max.getTime() - w2.min.getTime(), 20 * 60 * 1000);
  console.log('  ok  ventana de 2h +/- tolerancia');
  passed += 1;

  const event = {
    title: 'Reunion de equipo',
    description: 'Revision semanal',
    location: 'Sala 3',
    startAt: new Date(now.getTime() + 24 * 3600 * 1000),
    endAt: new Date(now.getTime() + 25 * 3600 * 1000),
  };
  const text24 = cron.buildReminderText(event, 24);
  assert.ok(text24.includes('24 horas'));
  assert.ok(text24.includes('Reunion de equipo'));
  console.log('  ok  texto del recordatorio 24h');
  passed += 1;

  const text2 = cron.buildReminderText(event, 2);
  assert.ok(text2.includes('2 horas'));
  console.log('  ok  texto del recordatorio 2h');
  passed += 1;

  console.log(`\n${passed} comprobaciones OK\n`);
})();
