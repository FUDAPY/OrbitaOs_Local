'use strict';
/**
 * Sonda de fechas: descubre que formato de fecha devuelve Space Bunny Alpha
 * para distintas formas de pedir una cita.
 */

const url = process.env.SPACE_BUNNY_API_URL || 'https://spacebunnymodel.com/api/v1/chat/completions';
const key = process.env.SPACE_BUNNY_API_KEY || '';

const CASOS = [
  'Agenda una reunion mañana a las 15:00',
  'Agenda una cita con el doctor el 12/09/2026 a las 10:30',
  'Reunion el viernes 3 de octubre a las 18:00',
  'Proxima reunion: 2026-10-05T14:00:00Z',
];

(async () => {
  for (const caso of CASOS) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.SPACE_BUNNY_MODEL || 'space-bunny-alpha',
        messages: [
          {
            role: 'system',
            content:
              'Eres OrbitaOs, un asistente de operaciones. Tu respuesta DEBE ser un JSON con: { "intent": "chat | schedule_event | create_document | add_task | update_task", "response_text": "Respuesta al usuario", "data": {} }.',
          },
          { role: 'user', content: caso },
        ],
        temperature: 0.2,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
      }),
    });

    const payload = await res.json();
    const content = payload.choices?.[0]?.message?.content || '';
    let data = {};
    try {
      data = JSON.parse(content).data || {};
    } catch (_) {
      /* se muestra crudo */
    }
    console.log(`\n> ${caso}`);
    console.log(`  data = ${JSON.stringify(data)}`);
  }
})();
