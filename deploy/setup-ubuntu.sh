#!/usr/bin/env bash
# Provisions a fresh Ubuntu 22.04/24.04 GCE VM to run the panel scraper.
# Idempotent -- safe to re-run after a code update.
#
#   sudo bash deploy/setup-ubuntu.sh
#
# Deliberately no Docker: the only stateful thing is the browser profile
# directory, which a plain VM disk handles without a volume mount.
set -euo pipefail

APP_USER="${APP_USER:-h10}"
APP_DIR="${APP_DIR:-/opt/helium10-panel-scraper}"
NODE_MAJOR="${NODE_MAJOR:-22}"

echo "==> System packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git unzip

echo "==> Node ${NODE_MAJOR}"
# process.loadEnvFile() needs Node >= 20.12; 22 LTS is the safe floor.
if ! command -v node >/dev/null 2>&1 || \
   [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
fi
node --version

echo "==> Service account ${APP_USER}"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"

echo "==> App directory ${APP_DIR}"
mkdir -p "$APP_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

if [ ! -f "$APP_DIR/package.json" ]; then
  echo "!! Copy the repo to $APP_DIR first (rsync/scp/git clone), then re-run."
  exit 1
fi

echo "==> npm dependencies"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npm ci --omit=dev"

echo "==> Chromium + its system libraries"
# --with-deps is the part that matters: it installs the ~60 shared libraries
# headless Chromium needs, which a bare VM image does not ship.
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npx playwright install --with-deps chromium"

echo "==> Vendoring the Helium 10 extension"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && node scripts/fetch-extension.mjs"

echo "==> Runtime directories"
sudo -u "$APP_USER" mkdir -p "$APP_DIR/profile" "$APP_DIR/output" "$APP_DIR/input"

if [ ! -f "$APP_DIR/.env" ]; then
  echo "!! No $APP_DIR/.env yet. Create it (see .env.example), chmod 600, then:"
  echo "     systemctl restart h10-scraper"
fi

echo "==> systemd unit"
install -m 644 "$APP_DIR/deploy/h10-scraper.service" /etc/systemd/system/h10-scraper.service
sed -i "s|__APP_DIR__|$APP_DIR|g; s|__APP_USER__|$APP_USER|g" /etc/systemd/system/h10-scraper.service
systemctl daemon-reload
systemctl enable h10-scraper

echo
echo "Done. Next:"
echo "  1. Put credentials + DB settings in $APP_DIR/.env  (chmod 600)."
echo "     Start with SCRAPER_MODE=dev so a first sweep cannot touch staging."
echo "     Both DB hosts must whitelist this VM's egress IP (firewall + pg_hba)."
echo
echo "  2. Give it a Helium 10 session. There is no display here, so it cannot"
echo "     solve the reCAPTCHA -- copy one in from a machine that can:"
echo "        on your laptop:  npm run login && npm run profile:save"
echo "        scp profile-seed.tar.gz $APP_DIR/"
echo "        here:            sudo -u $APP_USER bash -lc 'cd $APP_DIR && npm run profile:load'"
echo "     (\`npm run auth\` will NOT sign in -- it refuses to submit the login"
echo "      form without --submit, because a submission that meets a CAPTCHA"
echo "      revokes the session the seed just installed.)"
echo
echo "  3. Verify, in this order:"
echo "        npm run dbcheck      # prints the RESOLVED target for SCRAPER_MODE"
echo "        npm run session      # read-only; must say LIVE"
echo "        npm run notifycheck  # proves Cliq alerts reach the channel from here"
echo "        npm run probe B0BCJFJV4W   # proves the panel parses from this IP"
echo
echo "  4. systemctl start h10-scraper && journalctl -u h10-scraper -f"
echo "     The UI binds 127.0.0.1 only. Reach it with:"
echo "        ssh -L 8090:localhost:8090 <user>@<this-vm>"
echo
echo "  5. First real sweep: upload a SMALL sheet and watch the TIMEOUT rate."
echo "     Under ~5% is a healthy IP; climbing past ~15% means Amazon is"
echo "     squeezing it -- stop and rest it rather than burning the sheet."
