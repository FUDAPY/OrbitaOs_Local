'use strict';
// OrbitaOs - capa de busqueda web con DuckDuckGo.

const DDG = require('duckduckgo-search');

/** Maximo de resultados pedidos y pasado al modelo. */
const MAX_RESULTADOS = 3;
const TIMEOUT_BUSQUEDA_MS = 15000;

/** User-Agent de navegador: sin esto DuckDuckGo corta la peticion. */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** Headers comunes a las peticiones a DuckDuckGo. */
const HEADERS = { 'User-Agent': UA, 'Accept-Language': 'es,en;q=0.8' };

// Busca en DuckDuckGo y devuelve fragmentos listos para el modelo.
async function buscar(query, options = {}) {
  const q = String(query || '').trim();
  const max = Number(options.max || MAX_RESULTADOS);

  if (!q) {
    return {
      ok: false,
      query: '',
      resultados: [],
      error: 'La consulta de búsqueda está vacía.',
    };
  }

  const resultados = [];

  // --- Fuente 1: busqueda web real ---
  try {
    resultados.push(...(await buscarWeb(q, max)));
  } catch (err) {
    console.warn(`[web] busqueda web fallo: ${err.message}`);
  }

  // --- Fuente 2: respuestas directas, como refuerzo ---
  if (resultados.length < max) {
    try {
      resultados.push(...(await buscarInstant(q, max - resultados.length)));
    } catch (err) {
      console.warn(`[web] respuestas directas fallo: ${err.message}`);
    }
  }

  // --- Ultimo recurso: la libreria ---
  if (resultados.length === 0) {
    try {
      resultados.push(...(await buscarConLibreria(q, max)));
    } catch (err) {
      console.warn(`[web] libreria fallo: ${err.message}`);
    }
  }

  // Deduplica: las fuentes pueden repetir el mismo contenido.
  const vistos = new Set();
  const unicos = resultados.filter((r) => {
    const clave = r.url || String(r.snippet).slice(0, 60);
    if (vistos.has(clave)) return false;
    vistos.add(clave);
    return true;
  });

  if (!unicos.length) {
    return {
      ok: false,
      query: q,
      resultados: [],
      error:
        'DuckDuckGo no devolvió resultados para esta consulta. ' +
        'Puede ser un tema muy reciente o un bloqueo temporal del servicio.',
    };
  }

  return { ok: true, query: q, resultados: unicos.slice(0, max), error: null };
}

/** Quita etiquetas HTML y decodifica las entidades basicas. */
function limpiarHtml(texto) {
  return String(texto || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


// Busca en la version HTML de DuckDuckGo y parsea los resultados.
async function buscarWeb(q, max) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const controlador = new AbortController();
  const timeout = setTimeout(() => controlador.abort(), TIMEOUT_BUSQUEDA_MS);

  try {
    const res = await fetch(url, {
      headers: { ...HEADERS, Accept: 'text/html,application/xhtml+xml' },
      signal: controlador.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const html = await res.text();
    const salida = [];

    // Cada resultado es un bloque con enlace y snippet.
    const bloques = html.split('result results_links').slice(1);

    for (const bloque of bloques) {
      if (salida.length >= max) break;

      const enlace = bloque.match(
        /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/
      );
      if (!enlace) continue;

      const titulo = limpiarHtml(enlace[2]);
      if (!titulo) continue;

      // Los enlaces vienen en un redirector: se saca el destino real.
      const crudo = enlace[1].replace(/^\/\//, 'https://');
      const destino = crudo.match(/[?&]uddg=([^&]+)/);
      const href = destino ? decodeURIComponent(destino[1]) : crudo;

      const snippet = bloque.match(
        /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/
      );

      salida.push({
        title: titulo.slice(0, 150),
        url: href,
        snippet: snippet ? limpiarHtml(snippet[1]).slice(0, 400) : '',
        source: 'DuckDuckGo',
      });
    }

    return salida;
  } finally {
    clearTimeout(timeout);
  }
}

// Consulta las respuestas directas de DuckDuckGo.
async function buscarInstant(q, max) {
  const url =
    `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}` +
    '&format=json&no_html=1&skip_disambig=1&t=orbitaos';

  const controlador = new AbortController();
  const timeout = setTimeout(() => controlador.abort(), TIMEOUT_BUSQUEDA_MS);

  try {
    const res = await fetch(url, {
      headers: { ...HEADERS, Accept: 'application/json' },
      signal: controlador.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const salida = [];

    if (data.AbstractText && data.AbstractText.trim()) {
      salida.push({
        title: data.Heading || q,
        url: data.AbstractURL || '',
        snippet: String(data.AbstractText).trim().slice(0, 500),
        source: data.AbstractSource || 'DuckDuckGo',
      });
    }

    for (const t of data.RelatedTopics || []) {
      if (salida.length >= max) break;
      if (t.Text && t.FirstURL) {
        salida.push({
          title: String(t.Text).split(' - ')[0].slice(0, 120),
          url: t.FirstURL,
          snippet: String(t.Text).trim().slice(0, 300),
          source: 'DuckDuckGo',
        });
      }
    }

    return salida;
  } finally {
    clearTimeout(timeout);
  }
}

// Usa la libreria duckduckgo-search como ultimo recurso.
async function buscarConLibreria(q, max) {
  const r = await DDG.text(q, { region: 'wt-wt', max_results: max });
  // La libreria devuelve { results: [...] } o un array segun la version.
  const lista = Array.isArray(r)
    ? r
    : r && Array.isArray(r.results)
      ? r.results
      : [];

  return lista.slice(0, max).map((x) => ({
    title: String(x.title || '').slice(0, 150),
    url: String(x.url || ''),
    snippet: String(x.body || x.description || '').slice(0, 400),
    source: 'DuckDuckGo',
  }));
}

// Formatea los resultados como texto para el contexto del modelo.
function formatearResultados(resultados) {
  if (!resultados || !resultados.length) return 'Sin resultados.';
  return resultados
    .map((r, i) => {
      const partes = [`[${i + 1}] ${r.title}`];
      if (r.snippet) partes.push(`   ${r.snippet}`);
      if (r.url) partes.push(`   Fuente: ${r.url}`);
      return partes.join('\n');
    })
    .join('\n\n');
}

module.exports = {
  buscar,
  formatearResultados,
  MAX_RESULTADOS,
};
