'use strict';
// OrbitaOs - prueba de extremo a extremo contra la API real.

const ai = require('../src/ai_router');

const MENSAJES = [
  'Agenda una reunion mañana a las 15:00',
  'Agenda una cita con el doctor el 12/09/2026 a las 10:30',
  'Reunion el viernes 3 de octubre a las 18:00',
  'Proxima reunion: 2026-10-05T14:00:00Z',
];

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

(async () => {
  console.log('\nFlujo completo contra la API real\n');
  let ok = 0;
  let fallos = 0;

  for (const mensaje of MENSAJES) {
    const r = await ai.route(mensaje, {
      history: [],
      timezone: 'America/Argentina/Buenos_Aires',
    });

    const startAt = ai.resolveEventDate(r.data);
    const usable = startAt instanceof Date && !Number.isNaN(startAt.getTime());

    console.log(`> ${mensaje}`);
    console.log(`  intent:   ${r.intent}`);
    console.log(`  data:     ${JSON.stringify(r.data)}`);
    console.log(`  fecha:    ${usable ? stamp(startAt) : '*** NO RESUELTA ***'}`);
    console.log('');

    if (r.intent === 'schedule_event' && usable) ok += 1;
    else fallos += 1;
  }

  console.log(`Eventos con fecha utilizable: ${ok}/${MENSAJES.length}`);
  process.exit(fallos ? 1 : 0);
})();
