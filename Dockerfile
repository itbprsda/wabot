FROM node:20-slim

RUN apt-get update && apt-get install -y \
    chromium \
    dumb-init \
    fonts-freefont-ttf \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-noto-core \
    fonts-noto-color-emoji \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libgbm1 \
    libxss1 \
    libxrandr2 \
    libpangocairo-1.0-0 \
    libgtk-3-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libx11-xcb1 \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PORT=8000

EXPOSE 8000

WORKDIR /app

COPY package.json .
COPY fix-remoteauth.js .
RUN npm install --omit=dev

COPY . .

# Directory layout:
#   /app/.wwebjs_auth   — RemoteAuth session zips (backed up to MongoDB)
#   /tmp/.chrome-data   — Chrome user-data-dir (in /tmp: always writable,
#                         no ownership issues, survives within container
#                         lifetime; cross-restart persistence is handled by
#                         MongoDB RemoteAuth, not the filesystem)
#   /tmp/chrome-crashes — Chrome crash dumps (Chrome refuses to start without
#                         a writable crash dir)
#
# NOTE: We no longer create /app/.chrome-data — using /tmp instead avoids
# the ownership/permission issues that caused Chrome's WebSocket to drop
# silently after QR scan on Koyeb.
RUN groupadd -r appuser && useradd -r -g appuser -G audio,video appuser \
    && mkdir -p /home/appuser/Downloads \
    && mkdir -p /app/.wwebjs_auth \
    && mkdir -p /tmp/.chrome-data \
    && mkdir -p /tmp/chrome-crashes \
    && chown -R appuser:appuser /home/appuser \
    && chown -R appuser:appuser /app \
    && chown -R appuser:appuser /tmp/.chrome-data \
    && chown -R appuser:appuser /tmp/chrome-crashes

USER appuser

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]