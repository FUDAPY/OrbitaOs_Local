'use strict';
// OrbitaOs - prueba de conexion con Space Bunny Alpha.

const url =
  process.env.SPACE_BUNNY_API_URL ||
  'https://spacebunnymodel.com/api/v1/chat/completions';
const key = process.env.SPACE_BUNNY_API_KEY || '';
const model = process.env.SPACE_BUNNY_MODEL || 'space-bunny-alpha';

if (!key) {
  console.error('Falta SPACE_BUNNY_API_KEY.');
  process.exit(1);
}

console.log(`Probando ${url}`);
console.log(`Modelo:  ${model}`);
console.log(`Clave:   ${key.slice(0, 10)}...${key.slice(-4)}\n`);

(async () => {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              'Eres OrbitaOs, un asistente de operaciones. Tu respuesta DEBE ser un JSON con: { "intent": "chat | schedule_event | create_document | add_task | update_task", "response_text": "Respuesta al usuario", "data": {} }.',
          },
          { role: 'user', content: 'Agenda una reunion mañana a las 15:00' },
        ],
        temperature: 0.2,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
      }),
    });

    console.log(`HTTP ${res.status} ${res.statusText}`);

    const raw = await res.text();
    if (!res.ok) {
      console.log('\nRespuesta del servidor:\n' + raw.slice(0, 800));
      process.exit(1);
    }

    const payload = JSON.parse(raw);
    const content =
      payload.choices &&
      payload.choices[0] &&
      payload.choices[0].message &&
      payload.choices[0].message.content;

    console.log('\n--- Contenido devuelto ---');
    console.log(String(content).slice(0, 1200));
    console.log('\n--- Metadatos ---');
    console.log('usage:', JSON.stringify(payload.usage || {}));

    // Se pasa por el mismo normalizador que usa el bot.
    const ai = require('../src/ai_router');
    const parsed = ai.extractJson(content);
    const normalized = ai.normalize(parsed);
    console.log('\n--- Normalizado por ai_router ---');
    console.log(JSON.stringify(normalized, null, 2).slice(0, 900));

    const ok = parsed !== null && ['chat', 'schedule_event', 'create_document', 'add_task', 'update_task'].includes(normalized.intent);
    console.log(`\n${ok ? 'OK: la API responde con el contrato esperado.' : 'REVISAR: la respuesta no cumple el contrato.'}`);
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error(`\nERROR de red: ${err.message}`);
    process.exit(1);
  }
})();
