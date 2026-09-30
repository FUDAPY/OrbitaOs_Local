'use strict';
// Valida los esquemas Mongoose sin MongoDB: modelos, indices y validacion de documentos.

const assert = require('assert');
const db = require('../src/database');

const { User, Message, Event, Task } = db;

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

console.log('\nModelos');

check('los 4 modelos compilan', () => {
  for (const m of [User, Message, Event, Task]) {
    assert.ok(m.modelName, 'modelo sin nombre');
  }
  assert.strictEqual(User.modelName, 'User');
  assert.strictEqual(Message.modelName, 'Message');
  assert.strictEqual(Event.modelName, 'Event');
  assert.strictEqual(Task.modelName, 'Task');
});

check('User exige username', () => {
  const v = new User({});
  assert.ok(v.validateSync().errors.username, 'no se reporto el error de username');
});

check('User acepta un documento valido', () => {
  const v = new User({ username: 'thesadboy', passwordHash: 'scrypt$1$2$3$a$b' });
  assert.strictEqual(v.validateSync(), undefined);
  assert.strictEqual(v.role, 'member');
  assert.strictEqual(v.allowed, true);
  assert.strictEqual(v.phone, null, 'el telefono es opcional');
});

check('el hash queda excluido de las consultas (select:false)', () => {
  // select:false actua sobre find()/findOne(), no sobre una instancia nueva.
  assert.strictEqual(
    User.schema.path('passwordHash').selected,
    false,
    'passwordHash debe tener select:false para no filtrarse en un listado'
  );
  // Y aun asi se puede leer de forma explicita.
  assert.strictEqual(User.schema.path('passwordHash').options.select, false);
});

check('User rechaza un username muy corto', () => {
  const v = new User({ username: 'ab', passwordHash: 'h' });
  assert.ok(v.validateSync().errors.username);
});

check('User normaliza el username a minusculas', () => {
  const v = new User({ username: 'TheSadBoy', passwordHash: 'h' });
  assert.strictEqual(v.username, 'thesadboy');
});

check('el indice de lista blanca existe en User', () => {
  const idx = User.schema.indexes().map((i) => JSON.stringify(i[0]));
  assert.ok(idx.includes(JSON.stringify({ phone: 1, allowed: 1 })));
});

check('Message exige chatId, from, to, direction y body', () => {
  const v = new Message({});
  const errs = v.validateSync().errors;
  for (const field of ['chatId', 'from', 'to', 'direction', 'body']) {
    assert.ok(errs[field], `falta error en ${field}`);
  }
});

check('Message rechaza una direccion invalida', () => {
  const v = new Message({
    chatId: '1', from: '1', to: '2', direction: 'lateral', body: 'x',
  });
  assert.ok(v.validateSync().errors.direction);
});

check('Event exige title, owner, createdBy, chatId y startAt', () => {
  const v = new Event({});
  const errs = v.validateSync().errors;
  for (const field of ['title', 'owner', 'createdBy', 'chatId', 'startAt']) {
    assert.ok(errs[field], `falta error en ${field}`);
  }
});

check('Event crea los recordatorios h24 y h2 sin enviar', () => {
  const e = new Event({
    title: 'Reunion',
    owner: '54911123456789',
    createdBy: '54911123456789',
    chatId: '54911123456789',
    startAt: new Date(),
  });
  assert.strictEqual(e.validateSync(), undefined);
  assert.strictEqual(e.reminders.h24.sent, false);
  assert.strictEqual(e.reminders.h2.sent, false);
  assert.strictEqual(e.status, 'confirmed');
});

check('Event guarda endAt y location', () => {
  const start = new Date('2026-10-01T15:00:00Z');
  const e = new Event({
    title: 'Cliente',
    owner: '1', createdBy: '1', chatId: '1',
    startAt: start,
    endAt: new Date(start.getTime() + 3600000),
    location: 'Oficina',
  });
  assert.strictEqual(e.endAt.getTime(), start.getTime() + 3600000);
  assert.strictEqual(e.location, 'Oficina');
});

check('Task usa valores por defecto del pipeline', () => {
  const t = new Task({
    title: 'Llamar al proveedor',
    owner: '1', createdBy: '1', chatId: '1',
  });
  assert.strictEqual(t.validateSync(), undefined);
  assert.strictEqual(t.status, 'todo');
  assert.strictEqual(t.priority, 'medium');
  assert.strictEqual(t.position, 0);
  assert.deepStrictEqual(t.labels, []);
});

check('Task acepta cada columna del Kanban', () => {
  for (const status of ['backlog', 'todo', 'in_progress', 'review', 'done']) {
    const t = new Task({
      title: 'x', owner: '1', createdBy: '1', chatId: '1', status,
    });
    assert.strictEqual(t.validateSync(), undefined, `rechaza ${status}`);
  }
});

check('Task rechaza un estado desconocido', () => {
  const t = new Task({
    title: 'x', owner: '1', createdBy: '1', chatId: '1', status: 'inventado',
  });
  assert.ok(t.validateSync().errors.status);
});

check('Task acepta cada prioridad', () => {
  for (const priority of ['low', 'medium', 'high', 'urgent']) {
    const t = new Task({
      title: 'x', owner: '1', createdBy: '1', chatId: '1', priority,
    });
    assert.strictEqual(t.validateSync(), undefined, `rechaza ${priority}`);
  }
});

check('los indices del cron estan definidos en Event', () => {
  const idx = Event.schema.indexes().map((i) => JSON.stringify(i[0]));
  assert.ok(idx.includes(JSON.stringify({ 'reminders.h24.sent': 1, startAt: 1 })));
  assert.ok(idx.includes(JSON.stringify({ 'reminders.h2.sent': 1, startAt: 1 })));
});

check('el indice de historial existe en Message', () => {
  const idx = Message.schema.indexes().map((i) => JSON.stringify(i[0]));
  assert.ok(idx.includes(JSON.stringify({ chatId: 1, createdAt: -1 })));
});

check('los 4 modelos tienen timestamps', () => {
  for (const m of [User, Message, Event, Task]) {
    assert.ok(m.schema.path('createdAt'), `${m.modelName} sin createdAt`);
    assert.ok(m.schema.path('updatedAt'), `${m.modelName} sin updatedAt`);
  }
});

console.log(`\n${passed} comprobaciones OK\n`);
