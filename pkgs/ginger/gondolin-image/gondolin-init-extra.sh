mkdir -p /.rw-nix/store
mkdir -p /.rw-nix/workdir
mkdir -p /nix/store
mount -t overlay overlay \
    -o lowerdir="/.ro-nix/nix/store" \
    -o upperdir="/.rw-nix/store" \
    -o workdir="/.rw-nix/workdir" \
    /nix/store
mkdir -p /etc/nix
cat /etc/ssl/cert.pem /etc/gondolin/mitm/ca.crt > /etc/nix/cert.pem
if ! id nixbld1 > /dev/null 2>&1; then
  addgroup -S nixbld 2>/dev/null || true
  for n in $(seq 1 10); do adduser -g "Nix build user $n" \
    -h /var/empty -G nixbld -H -S -s "$(which nologin)" \
    "nixbld$n"; done
fi
cat > /etc/nix/nix.conf << EOF
experimental-features = nix-command flakes local-overlay-store read-only-local-store
trusted-users = root
store = local-overlay://?upper-layer=/.rw-nix/store&lower-store=/.ro-nix?read-only=true
EOF
cat > /root/.bashrc <<EOF
eval $(/bin/direnv hook bash)
EOF
cat > /root/.gitconfig <<EOF
[safe]
	directory = *
[user]
    email = ginger@andrewlubawy.com
    name = Ginger Agent
EOF

# Create messagebus user (needed by dbus-daemon)
if ! id messagebus > /dev/null 2>&1; then
  addgroup -S messagebus 2>/dev/null || true
  adduser -S -G messagebus -h /dev/null -s /sbin/nologin messagebus 2>/dev/null || true
fi

# Compile GSettings schemas (APK post-install scripts don't run)
if command -v glib-compile-schemas > /dev/null 2>&1; then
  glib-compile-schemas /usr/share/glib-2.0/schemas/ 2>/dev/null || true
fi

# Start D-Bus system bus (needed by Chromium)
mkdir -p /run/dbus
if command -v dbus-daemon > /dev/null 2>&1; then
  dbus-daemon --config-file=/share/dbus-1/system.conf
  log "[init] started dbus"
fi

# Point session bus at system bus (no desktop session in sandbox)
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/dbus/system_bus_socket

# Start the Playwright dashboard daemon and route it through gondolin
# ingress. The route is `/` (not a subpath prefix): the dashboard only
# serves at its own root — it 302-redirects `/` to `/index.html?ws=…` and
# references all assets with absolute paths (`/assets/…`), which a
# prefix-stripping route would send back to the listen address outside the
# routed prefix. At `/`, every path the app emits stays inside the route.
# Idempotent: re-running init on a resumed disk skips the start if something
# is already listening, and the route is only appended when missing (the
# playwright-dashboard helper owns that logic). The port can be overridden
# via PLAYWRIGHT_DASHBOARD_PORT; the resolved port is exported and persisted
# to /run/gondolin/playwright.port so it survives even if the listeners file
# is overwritten by hand (`playwright-dashboard` restores the route from it).
PLAYWRIGHT_PORT="${PLAYWRIGHT_DASHBOARD_PORT:-9323}"
export PLAYWRIGHT_DASHBOARD_PORT="$PLAYWRIGHT_PORT"
if command -v playwright-cli > /dev/null 2>&1; then
  mkdir -p /run/gondolin
  echo "$PLAYWRIGHT_PORT" >/run/gondolin/playwright.port
  if ! curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${PLAYWRIGHT_PORT}/"; then
    nohup playwright-cli show --port "$PLAYWRIGHT_PORT" \
      >>/var/log/playwright-dashboard.log 2>&1 &
    log "[init] started playwright dashboard on port ${PLAYWRIGHT_PORT}"
  fi
  if command -v playwright-dashboard > /dev/null 2>&1; then
    playwright-dashboard add
  else
    log "[init] warning: playwright-dashboard helper not found, skipping route"
  fi
fi

# Set default Chromium flags for headless sandbox use.
# Alpine's /usr/bin/chromium wrapper sources /etc/chromium/*.conf in lexical order.
# We use a filename that sorts *after* chromium.conf so we can append to distro defaults.
mkdir -p /opt/google/chrome
mkdir -p /etc/chromium
# -fn: idempotent. On a resumed disk these symlinks already exist from the
# previous boot, and plain `ln -s` fails under the init script's `set -eu`,
# which kills init before sandboxd starts (guest never becomes ready).
ln -sfn /share/fonts /usr/share/fonts
ln -sfn "$(readlink -f /usr/bin/chromium || echo "/usr/bin/chromium")" /opt/google/chrome/chrome
rm -f /etc/chromium/zz-gondolin.conf
cat > /etc/chromium/zz-gondolin.conf <<'EOF'
# Appended to any distro defaults from other .conf files
CHROMIUM_FLAGS="$CHROMIUM_FLAGS --headless --no-sandbox --disable-gpu --ignore-certificate-errors --no-first-run --no-default-browser-check"
EOF
log "[init] configured default chromium flags"

chown root:root /dev/null
chmod 666 /dev/null
