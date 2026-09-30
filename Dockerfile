# syntax=docker/dockerfile:1
# OrbitaOs - imagen de produccion.
# whatsapp-web.js necesita un Chromium real: la imagen base no lo trae.
# ---------------------------------------------------------------------------

FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    TZ=America/Asuncion \
    CHROME_PATH=/usr/bin/chromium

# Chromium y sus dependencias de sistema (si faltan: "Could not find expected browser").
RUN apt-get update && apt-get install -y --no-install-recommends \
      dumb-init \
      ca-certificates \
      tzdata \
      chromium \
      fonts-liberation \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libatspi2.0-0 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libglib2.0-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-6 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Manifiestos primero: sin cambios en package.json se reutiliza la capa de cache.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY . .

# gosu baja privilegios sin usar su, para que Node quede bien como hijo.
RUN apt-get update && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*

# Directorios que deben sobrevivir a los reinicios (se montan como volumenes).
RUN mkdir -p /app/session /app/.wwebjs \
    && chown -R node:node /app

# Arranca como root a proposito: el entrypoint corrige permisos del volumen de
# sesion y borra los locks de Chromium, y despues baja a "node" con gosu.
# El paso siguiente normaliza CRLF/BOM y verifica el shebang del .sh.
RUN sed -i 's/\r$//' /app/docker-entrypoint.sh \
    && chmod +x /app/docker-entrypoint.sh \
    && head -c 2 /app/docker-entrypoint.sh | od -An -tx1 | grep -q '23 21' \
    || (printf 'el entrypoint no arranca con #!/bin/sh\n' && exit 1)

# Comprobacion de vida real: consulta el endpoint /health del servidor.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" || exit 1

# Chromium necesita un monticulo de memoria; 512MB es el minimo practico.
ENV NODE_OPTIONS=--max-old-space-size=512

# dumb-init: Node como PID 1 recibe las senales de parada del orquestador.
# dumb-init -> entrypoint (root) -> gosu -> node (node)
ENTRYPOINT ["dumb-init", "--", "/app/docker-entrypoint.sh"]

CMD ["node", "index.js"]
