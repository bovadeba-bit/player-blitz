FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8080 \
    TMPDIR=/app/.tmp \
    TEMP=/app/.tmp \
    TMP=/app/.tmp

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        python3 \
        python3-venv \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --ignore-scripts \
    && if [ -d /app/node_modules/ffmpeg-static ]; then \
         rm -f /app/node_modules/ffmpeg-static/ffmpeg \
         && ln -s /usr/bin/ffmpeg /app/node_modules/ffmpeg-static/ffmpeg; \
       fi

RUN python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir --upgrade pip yt-dlp

COPY . .

RUN mkdir -p /app/runtime /app/data /app/.audio-cache /app/.tmp \
    && printf '%s\n' \
       '#!/bin/sh' \
       'exec /opt/yt-dlp/bin/python -m yt_dlp "$@"' \
       > /app/runtime/yt-dlp \
    && chmod +x /app/runtime/yt-dlp \
    && chown -R 1000:1000 /app

USER 1000:1000

VOLUME ["/app/data", "/app/.audio-cache"]

EXPOSE 8080

CMD ["node", "server.js"]
