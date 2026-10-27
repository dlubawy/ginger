mkdir -p /.rw-nix/store
mkdir -p /.rw-nix/workdir
mkdir -p /nix/store
mount -t overlay overlay \
    -o lowerdir="/.ro-nix/store" \
    -o upperdir="/.rw-nix/store" \
    -o workdir="/.rw-nix/workdir" \
    /nix/store
mkdir -p /etc/nix
chmod 777 /dev/null
cat /etc/ssl/cert.pem /etc/gondolin/mitm/ca.crt > /etc/nix/cert.pem
if ! id nixbld1 > /dev/null 2>&1; then
  addgroup -S nixbld 2>/dev/null || true
  for n in $(seq 1 10); do adduser -g "Nix build user $n" \
    -h /var/empty -G nixbld -H -S -s "$(which nologin)" \
    "nixbld$n"; done
fi
cat > /etc/nix/nix.conf << EOF
experimental-features = nix-command flakes local-overlay-store
trusted-users = root
EOF
cat > /root/.bashrc <<EOF
eval $(/bin/direnv hook bash)
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

# Set default Chromium flags for headless sandbox use.
# Alpine's /usr/bin/chromium wrapper sources /etc/chromium/*.conf in lexical order.
# We use a filename that sorts *after* chromium.conf so we can append to distro defaults.
mkdir -p /opt/google/chrome
mkdir -p /etc/chromium
ln -s /share/fonts /usr/share/fonts
ln -s "$(readlink /usr/bin/chromium || echo "/usr/bin/chromium")" /opt/google/chrome/chrome
rm -f /etc/chromium/zz-gondolin.conf
cat > /etc/chromium/zz-gondolin.conf <<'EOF'
# Appended to any distro defaults from other .conf files
CHROMIUM_FLAGS="$CHROMIUM_FLAGS --headless --no-sandbox --disable-gpu --ignore-certificate-errors --no-first-run --no-default-browser-check"
EOF
log "[init] configured default chromium flags"
