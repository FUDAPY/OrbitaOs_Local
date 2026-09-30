'use strict';
// OrbitaOs - servidor HTTP.

const http = require('http');
const fs = require('fs');
const path = require('path');
const webApi = require('./web_api');
const recursos = require('./api_recursos');

const DEFAULT_PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/** Tipos de archivo que sirve el panel. */
const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/** Rutas validas, para el mensaje de error. */
const RUTAS = ['/health', '/api/estado', '/api/login', '/'];

let whatsappListo = false;
let ultimoCodigo = null;

// Marca que WhatsApp ya esta operativo.
function setReady(value) {
  whatsappListo = Boolean(value);
  recursos.setEstadoWhatsapp(() => (whatsappListo ? 'vinculado' : 'sin vincular'));
}

/**
 * Guarda el ultimo codigo de emparejamiento emitido.
 * Lo llama index.js, para poder consultarlo por HTTP.
 */
function setPairingCode(value) {
  ultimoCodigo = value || null;
  recursos.setCodigoVinculacion(() => (whatsappListo ? null : ultimoCodigo));
}

/** Respuesta JSON. */
function responderJson(res, status, cuerpo) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(cuerpo, null, 2));
}

// Sirve un archivo de public/.
function servirEstatico(res, rutaUrl) {
  let relativo;
  try {
    relativo = decodeURIComponent(rutaUrl);
  } catch (_) {
    return responderJson(res, 400, { error: 'ruta mal formada' });
  }

  // Se quitan los separadores iniciales y se normaliza el resto.
  relativo = path.normalize(relativo).replace(/^([/\\])+/, '');
  const destino = path.join(PUBLIC_DIR, relativo);

  if (!destino.startsWith(PUBLIC_DIR)) {
    return responderJson(res, 403, { error: 'ruta no permitida' });
  }

  fs.readFile(destino, (err, datos) => {
    if (err) {
      // El panel es una sola pagina y no usa rutas de navegacion, asi que una
      // direccion inexistente se responde como tal en vez de devolver el HTML.
      return responderJson(res, 404, { error: 'archivo no encontrado', rutas: RUTAS });
    }

    const tipo =
      TIPOS[path.extname(destino).toLowerCase()] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': tipo,
      // El HTML no se cachea: si no, un redeploy seguiria sirviendo el viejo.
      // Los estaticos llevan una hora, que alcanza para no pedirlos de nuevo.
      'Cache-Control': tipo.startsWith('text/html')
        ? 'no-cache'
        : 'public, max-age=3600',
    });
    res.end(datos);
  });
}

/** Sirve el panel (public/index.html). */
function servirIndex(res) {
  fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err, datos) => {
    if (err) {
      // Sin el panel en la imagen, el servidor sigue siendo util: dice que pasa.
      return responderJson(res, 500, {
        error: 'el panel no está disponible en esta imagen',
        detalle: err.message,
        rutas: RUTAS,
      });
    }
    res.writeHead(200, {
      'Content-Type': TIPOS['.html'],
      'Cache-Control': 'no-cache',
    });
    res.end(datos);
  });
}

// Arranca el servidor HTTP.
function startHealthServer(options = {}) {
  const port = Number(options.port || process.env.PORT || DEFAULT_PORT);

  // El cliente de WhatsApp se publica en la API: los mensajes programados y el
  // panel pueden disparar envios sin volver a pasar por index.js.
  if (options.client) webApi.setCliente(options.client);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    try {
      // 1. Chequeo de vida: rapido y sin tocar la base.
      if (url.pathname === '/health' || url.pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('ok');
        return;
      }

      // 2. La API del panel.
      if (await webApi.manejar(req, res, url)) return;

      // 3. El panel.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        responderJson(res, 405, { error: 'método no permitido', rutas: RUTAS });
        return;
      }

      servirEstatico(res, url.pathname === '/' ? 'index.html' : url.pathname);
    } catch (err) {
      console.error(`[http] ${req.method} ${req.url}: ${err.message}`);
      if (!res.headersSent) {
        responderJson(res, 500, { error: 'error interno', detalle: err.message });
      }
    }
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`[http] panel y API escuchando en el puerto ${port}`);
      console.log(`[http]   panel: http://localhost:${port}/`);
      console.log(`[http]   salud: http://localhost:${port}/health`);
      console.log(`[http]   estado: http://localhost:${port}/api/estado`);
      resolve(server);
    });
  });
}

module.exports = {
  startHealthServer,
  setReady,
  setPairingCode,
  responderJson,
  servirEstatico,
  DEFAULT_PORT,
  PUBLIC_DIR,
  RUTAS,
};

