#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
NODE_BINARY=$(command -v node || true)
NPM_BINARY=$(command -v npm || true)

if [ -z "$NODE_BINARY" ] || [ -z "$NPM_BINARY" ]; then
  echo "Node.js 20 or newer and npm must be installed system-wide." >&2
  exit 1
fi

NODE_MAJOR=$("$NODE_BINARY" -p "Number(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 20 or newer is required; found $("$NODE_BINARY" --version)." >&2
  exit 1
fi

for required_file in \
  "$REPOSITORY_DIR/dist/server/index.js" \
  "$REPOSITORY_DIR/dist/client/index.html" \
  "$REPOSITORY_DIR/package.json" \
  "$REPOSITORY_DIR/package-lock.json"; do
  if [ ! -f "$required_file" ]; then
    echo "Missing $required_file. Run npm ci, npm test, and npm run build first." >&2
    exit 1
  fi
done

if ! getent passwd kitchen-display >/dev/null; then
  useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin kitchen-display
fi

install -d -o root -g root -m 0755 /opt/kitchen-display /opt/kitchen-display/releases
install -d -o root -g root -m 0700 /etc/kitchen-display

if [ ! -f /etc/kitchen-display/environment ]; then
  TOKEN=$("$NODE_BINARY" -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")
  ENVIRONMENT_FILE=$(mktemp /etc/kitchen-display/environment.XXXXXX)
  chmod 0600 "$ENVIRONMENT_FILE"
  cat >"$ENVIRONMENT_FILE" <<EOF
KITCHEN_DISPLAY_API_TOKEN=$TOKEN
HOST=0.0.0.0
PORT=80
STATE_FILE=/var/lib/kitchen-display/state.json
PUBLIC_DIR=/opt/kitchen-display/current/dist/client
LOG_LEVEL=info
EOF
  mv "$ENVIRONMENT_FILE" /etc/kitchen-display/environment
  unset TOKEN
fi

RELEASE_ID=$(date -u +%Y%m%dT%H%M%SZ)-$$
RELEASE_DIR=/opt/kitchen-display/releases/$RELEASE_ID
install -d -o root -g root -m 0755 "$RELEASE_DIR"
cp -a "$REPOSITORY_DIR/dist" "$RELEASE_DIR/dist"
cp "$REPOSITORY_DIR/package.json" "$REPOSITORY_DIR/package-lock.json" "$RELEASE_DIR/"

(
  cd "$RELEASE_DIR"
  "$NPM_BINARY" ci --omit=dev --ignore-scripts
)
chown -R root:root "$RELEASE_DIR"

UNIT_FILE=$(mktemp)
sed "s|@NODE_BINARY@|$NODE_BINARY|" "$REPOSITORY_DIR/deploy/kitchen-display.service" >"$UNIT_FILE"
install -o root -g root -m 0644 "$UNIT_FILE" /etc/systemd/system/kitchen-display.service
rm -f "$UNIT_FILE"

PREVIOUS_RELEASE=$(readlink -f /opt/kitchen-display/current 2>/dev/null || true)
NEW_LINK=/opt/kitchen-display/.current-$$
ln -s "$RELEASE_DIR" "$NEW_LINK"
mv -Tf "$NEW_LINK" /opt/kitchen-display/current

systemctl daemon-reload
systemctl enable kitchen-display.service >/dev/null
systemctl restart kitchen-display.service

READY=false
attempt=0
while [ "$attempt" -lt 20 ]; do
  if "$NODE_BINARY" -e \
    "fetch('http://127.0.0.1/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"; then
    READY=true
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done

if [ "$READY" != true ]; then
  echo "The new release did not become healthy." >&2
  if [ -n "$PREVIOUS_RELEASE" ] && [ -d "$PREVIOUS_RELEASE" ]; then
    ROLLBACK_LINK=/opt/kitchen-display/.rollback-$$
    ln -s "$PREVIOUS_RELEASE" "$ROLLBACK_LINK"
    mv -Tf "$ROLLBACK_LINK" /opt/kitchen-display/current
    systemctl restart kitchen-display.service
    echo "Rolled back to $PREVIOUS_RELEASE." >&2
  fi
  echo "Inspect logs with: sudo journalctl -u kitchen-display -n 100" >&2
  exit 1
fi

echo "Kitchen Display $RELEASE_ID is running."
echo "Open http://kitchen-display.local after configuring the hostname and Avahi."
echo "Read the Home Assistant token with: sudo sed -n 's/^KITCHEN_DISPLAY_API_TOKEN=//p' /etc/kitchen-display/environment"
