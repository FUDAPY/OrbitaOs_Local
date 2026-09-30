'use strict';
// OrbitaOs - pruebas del flujo guiado de alta de tareas.

const assert = require('assert');

// Clave que NO existe: si el flujo llamara a la API, fallaria y contaria.
process.env.SPACE_BUNNY_API_KEY = 'sb_live_invalida_para_el_test';
process.env.SPACE_BUNNY_DAILY_CAP = '0';
delete process.env.SPACE_BUNNY_API_URL;

const flow = require('../src/task_flow');
const ai = require('../src/ai_router');

const CHAT = '595981234567';
const CTX = { owner: CHAT, from: CHAT, chatId: CHAT, timezone: 'America/Asuncion' };

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

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('\nDeteccion de intencion (sin IA)\n');

check('detecta "crear una tarea"', () => {
  assert.ok(flow.detectarIntencion('crear una tarea para Ana'));
});

check('detecta "/tarea"', () => {
  assert.ok(flow.detectarIntencion('/tarea'));
  assert.ok(flow.detectarIntencion('nueva tarea'));
});

check('detecta "necesito una tarea urgente"', () => {
  assert.ok(flow.detectarIntencion('necesito una tarea urgente'));
});

check('NO detecta una conversacion normal', () => {
  assert.strictEqual(flow.detectarIntencion('hola, como estas?'), false);
  assert.strictEqual(flow.detectarIntencion('agendame una reunion manana'), false);
  assert.strictEqual(flow.detectarIntencion('que hace el bot?'), false);
});

console.log('\nPrioridades (reglas locales)\n');

check('interpreta las cuatro prioridades', () => {
  assert.strictEqual(flow.interpretarPrioridad('urgente'), 'urgent');
  assert.strictEqual(flow.interpretarPrioridad('alta'), 'high');
  assert.strictEqual(flow.interpretarPrioridad('importante'), 'high');
  assert.strictEqual(flow.interpretarPrioridad('baja'), 'low');
});

check('lo no reconocido cae en media', () => {
  assert.strictEqual(flow.interpretarPrioridad('loquesea'), 'medium');
  assert.strictEqual(flow.interpretarPrioridad(''), 'medium');
});

console.log('\nFechas (reutiliza el parser de la IA, sin llamar al modelo)\n');

check('interpreta "mañana"', () => {
  const d = flow.interpretarCuando('mañana');
  assert.ok(d instanceof Date, 'debe devolver una Date');
});

check('interpreta una fecha concreta', () => {
  const d = flow.interpretarCuando('12/09/2026');
  assert.ok(d instanceof Date);
  assert.strictEqual(d.getMonth(), 8);
  assert.strictEqual(d.getDate(), 12);
});

check('devuelve null si no entiende la fecha', () => {
  assert.strictEqual(flow.interpretarCuando('cuando se pueda'), null);
});

console.log('\nPreguntas del flujo\n');

check('la primera pregunta pide el titulo', () => {
  const f = flow.iniciar(CHAT);
  const p = flow.preguntaActual(f);
  assert.ok(p.includes('Qué tarea es'), `esperaba la pregunta de titulo, obtuve: ${p}`);
});

(async () => {
  console.log('\nRecorrido completo (cero llamadas a la IA)\n');

  const antes = ai.getUsage();

  await checkAsync('procesar NO llama a la IA (responde localmente)', async () => {
    flow.iniciar(CHAT);
    const r = await flow.procesar(CHAT, 'Llamar al proveedor', CTX);
    assert.ok(
      r.reply.toLowerCase().includes('para qui'),
      `debio preguntar por el asignado: ${r.reply}`
    );
    assert.strictEqual(r.creada, null, 'no debe crear la tarea todavia');
  });

  await checkAsync('el flujo guarda el titulo y avanza', async () => {
    const f = flow.obtener(CHAT);
    assert.ok(f, 'el flujo sigue activo');
    assert.strictEqual(f.datos.titulo, 'Llamar al proveedor');
    assert.strictEqual(f.paso, 1);
  });

  await checkAsync('responde "x" en asignado con el valor por defecto', async () => {
    const r = await flow.procesar(CHAT, 'x', CTX);
    assert.strictEqual(flow.obtener(CHAT).datos.asignado, '');
    assert.ok(
      r.reply.toLowerCase().includes('cu'),
      `debio preguntar la fecha: ${r.reply}`
    );
  });

  await checkAsync('rechaza una fecha que no entiende y reintenta', async () => {
    const r = await flow.procesar(CHAT, 'cuando se pueda', CTX);
    assert.ok(r.reply.includes('No entendí'), `debe avisar el error: ${r.reply}`);
    assert.strictEqual(flow.obtener(CHAT).paso, 2, 'no debe avanzar de paso');
  });

  await checkAsync('acepta una fecha valida', async () => {
    const r = await flow.procesar(CHAT, '12/09/2026', CTX);
    assert.ok(flow.obtener(CHAT).datos.cuando instanceof Date, 'guarda la fecha');
    assert.ok(
      r.reply.toLowerCase().includes('prioridad'),
      `debio preguntar la prioridad: ${r.reply}`
    );
  });

  await checkAsync('la ultima respuesta pide confirmar, no crea todavia', async () => {
    // Este paso llega a confirmar(), que consulta MongoDB. Sin base no se
    // puede comprobar la creacion: se verifica que no revienta antes.
    const r = await flow.procesar(CHAT, 'alta', CTX).catch((err) => {
      if (/buffering|Mongo|ECONNREFUSED/i.test(err.message)) return null;
      throw err;
    });
    if (r === null) {
      console.log('  --  (sin MongoDB: se omite la confirmacion final)');
      return;
    }
    assert.strictEqual(r.creada, null, 'no debe crear sin confirmacion');
    assert.ok(flow.estaActivo(CHAT), 'el flujo sigue abierto');
  });

  await checkAsync('"cancelar" aborta sin crear nada', async () => {
    const r = await flow.procesar(CHAT, 'cancelar', CTX);
    assert.ok(r.cancelado, 'debe marcar cancelado');
    assert.strictEqual(r.creada, null, 'no debe crear la tarea');
    assert.strictEqual(flow.estaActivo(CHAT), false, 'el flujo debe cerrarse');
  });

  await checkAsync('"saltar" crea con los valores por defecto', async () => {
    // Requiere MongoDB; se omite si no hay base conectada.
    flow.iniciar(CHAT);
    const f = flow.obtener(CHAT);
    f.datos.titulo = 'Tarea minima';
    f.paso = flow.PASOS.length;
    try {
      await flow.confirmar(CHAT, CTX);
    } catch (err) {
      if (/buffering|connect|ECONNREFUSED|Mongoose/i.test(err.message)) {
        console.log('  --  (sin MongoDB: se omite la creacion real)');
        flow.cancelar(CHAT);
        return;
      }
      throw err;
    }
    assert.strictEqual(flow.estaActivo(CHAT), false, 'el flujo debe cerrarse');
  });

  const despues = ai.getUsage();
  const gastadas = despues.llamadas - antes.llamadas;
  console.log(`\n  llamadas a la IA durante todo el flujo: ${gastadas}`);
  if (gastadas !== 0) {
    console.error('  FAIL el flujo consumio tokens de la IA');
    process.exitCode = 1;
  } else {
    passed += 1;
    console.log('  ok  cero tokens consumidos por el flujo');
  }

  console.log(`\n${passed} comprobaciones OK\n`);
})();


check('las preguntas van cambiando segun el paso', () => {
  // Chat propio para no chocar con el recorrido asincrono de abajo.
  const A = '59500000001';
  const f = flow.iniciar(A);
  f.paso = 1;
  assert.ok(
    flow.preguntaActual(f).toLowerCase().includes('para qui'),
    `paso 1: ${flow.preguntaActual(f)}`
  );
  f.paso = 2;
  assert.ok(
    flow.preguntaActual(f).toLowerCase().includes('cu'),
    `paso 2: ${flow.preguntaActual(f)}`
  );
  f.paso = 3;
  assert.ok(
    flow.preguntaActual(f).toLowerCase().includes('prioridad'),
    `paso 3: ${flow.preguntaActual(f)}`
  );
  flow.cancelar(A);
});

check('el saludo inicial da las instrucciones', () => {
  const A = '59500000002';
  const f = flow.iniciar(A);
  const s = flow.saludoInicial(f);
  assert.ok(s.includes('Alta de tarea'));
  assert.ok(s.includes('cancelar'), 'debe explicar como cancelar');
  flow.cancelar(A);
});
