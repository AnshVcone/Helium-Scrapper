# The extension is provisioned at build time from Google's update service, so
# the image needs no Chrome Web Store interaction, no enterprise policy and no
# root privileges at runtime.
#
# Playwright's base image ships Chromium -- specifically NOT Chrome-branded,
# which is what keeps --load-extension working (Chrome 137+ removed it from
# branded builds).
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends unzip \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts
COPY public ./public

# Vendor + pin the extension into the image.
RUN node scripts/fetch-extension.mjs

# The profile must be a persistent volume: it carries the Helium 10 session, so
# a fresh profile means re-authenticating on every run -- slower, and worse for
# bot scoring.
VOLUME ["/app/profile", "/app/output", "/app/input"]

# HEADLESS=1 uses Chromium's new headless mode, which -- unlike the old one --
# supports extensions. NO_SANDBOX is required because the container runs as root.
ENV HEADLESS=1 \
    NO_SANDBOX=1

# H10_EMAIL / H10_PASSWORD come from the runtime secret store, never the image.
EXPOSE 8090

# The service exposes the upload form at / and the status page at /status.html.
CMD ["node", "src/server.js"]
