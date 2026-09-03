# Raspberry Pi installation and updates

Target: Raspberry Pi Zero 2 W running current Raspberry Pi OS Lite 64-bit. The
Pi is only an HTTP/SSE server; do not install a graphical desktop or Chromium.

## 1. Prepare the Pi

During Raspberry Pi Imager setup:

1. Set hostname to `kitchen-display`.
2. Configure the home Wi-Fi and SSH key.
3. Use a DHCP reservation so the Pi keeps a stable address.

After first boot, install Git, Avahi, and a current system-wide Node.js release
(version 20 or newer). Enable mDNS:

```sh
sudo apt update
sudo apt install -y git curl avahi-daemon
sudo systemctl enable --now avahi-daemon
node --version
npm --version
```

Raspberry Pi OS's Node.js package can lag behind. If `node --version` is older
than 20, install a current LTS version using a trusted Node.js package source
before continuing. The deployment script accepts any system-wide Node binary.

From another device on the LAN, confirm that this resolves to the Pi:

```sh
ping kitchen-display.local
```

## 2. Build and install

Clone this repository on the Pi, then run:

```sh
npm ci
npm run typecheck
npm test
npm run build
sudo sh scripts/install-pi.sh
```

The installer:

- creates an unprivileged `kitchen-display` user;
- generates a 256-bit token on first install;
- keeps the root-readable token in `/etc/kitchen-display/environment`;
- installs immutable releases below `/opt/kitchen-display/releases`;
- atomically points `/opt/kitchen-display/current` at the new release;
- installs and starts a hardened systemd service on port 80;
- retains `/var/lib/kitchen-display/state.json` across updates;
- rolls back the symlink if an update fails its health check.

It never replaces an existing token. Read the token once for Home Assistant:

```sh
sudo sed -n 's/^KITCHEN_DISPLAY_API_TOKEN=//p' /etc/kitchen-display/environment
```

Treat the output as a password. Do not paste it into logs, chat, or source
control.

## 3. Verify operation

```sh
systemctl status kitchen-display
curl http://kitchen-display.local/api/health
journalctl -u kitchen-display -n 100
```

Open `http://kitchen-display.local` from another LAN device. Do not forward port
80 on the router and do not expose the service through a public reverse proxy.

## Updating

Updates are deliberate:

```sh
git pull --ff-only
npm ci
npm run typecheck
npm test
npm run build
sudo sh scripts/install-pi.sh
```

Old releases are retained for manual rollback. To roll back, choose an earlier
directory and atomically replace the symlink:

```sh
ls -1 /opt/kitchen-display/releases
sudo ln -s /opt/kitchen-display/releases/RELEASE /opt/kitchen-display/.rollback
sudo mv -Tf /opt/kitchen-display/.rollback /opt/kitchen-display/current
sudo systemctl restart kitchen-display
```

Only remove old release directories after a newer version has worked on the
actual iPad and with Home Assistant.

## Operations

```sh
sudo systemctl restart kitchen-display
sudo systemctl stop kitchen-display
sudo systemctl start kitchen-display
sudo journalctl -u kitchen-display -f
```

To rotate the token, edit `/etc/kitchen-display/environment`, restart the
service, and immediately reconfigure the Kitchen Display integration in Home
Assistant. A mismatch intentionally makes all writes fail with HTTP 401.
