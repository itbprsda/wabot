FROM node:20-slim

# Install Chromium + all required system dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-freefont-ttf \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-symbola \
    fonts-noto \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libgbm1 \
    libxss1 \
    libasound2 \
    libxrandr2 \
    libpangocairo-1.0-0 \
    libgtk-3-0 \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to skip downloading its own Chrome bundle — use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy dependency files first (better layer caching)
COPY package.json .
COPY fix-remoteauth.js .
RUN npm install --omit=dev

# Copy the rest of the app
COPY . .

# Create a non-root user to run the app (security best practice)
# Chromium also works better when not running as root
RUN groupadd -r appuser && useradd -r -g appuser -G audio,video appuser \
    && mkdir -p /home/appuser/Downloads \
    && chown -R appuser:appuser /home/appuser \
    && chown -R appuser:appuser /app

USER appuser

EXPOSE 7860

CMD ["node", "index.js"]