# playwright-dashboard — manage the Playwright dashboard's ingress route.
#
# The dashboard is started at boot by /gondolin-init-extra.sh and routed via
# a '/' line in /etc/gondolin/listeners. If you overwrite that file (e.g. to
# point '/' at something else), use this script to restore or remove the
# dashboard route:
#
#   playwright-dashboard            add/restore the route (default)
#   playwright-dashboard add        same as default
#   playwright-dashboard remove     drop the dashboard route
#   playwright-dashboard port       print the dashboard port
#   playwright-dashboard status     show port, daemon state, route presence
#
# The port is read from /run/gondolin/playwright.port (written at boot),
# falling back to $PLAYWRIGHT_DASHBOARD_PORT, then 9323.

LISTENERS=/etc/gondolin/listeners
PORT_FILE=/run/gondolin/playwright.port

port() {
  if [ -f "$PORT_FILE" ]; then
    cat "$PORT_FILE"
  else
    echo "${PLAYWRIGHT_DASHBOARD_PORT:-9323}"
  fi
}

have_route() {
  # The ingress proxy rewrites route lines with a tab separator, so match
  # any whitespace between the path and the port.
  [ -f "$LISTENERS" ] && grep -qE "^/[[:space:]]+:$1$" "$LISTENERS"
}

cmd="${1:-add}"
case "$cmd" in
  add | restore)
    p="$(port)"
    mkdir -p "$(dirname "$LISTENERS")"
    touch "$LISTENERS"
    if have_route "$p"; then
      echo "route already present: / :$p"
    else
      echo "/ :$p" >>"$LISTENERS"
      echo "added route: / :$p"
    fi
    ;;
  remove)
    p="$(port)"
    if [ -f "$LISTENERS" ] && have_route "$p"; then
      # grep -v exits 1 when every line is filtered out; that is success.
      grep -vE "^/[[:space:]]+:${p}$" "$LISTENERS" >"$LISTENERS.tmp" || true
      mv "$LISTENERS.tmp" "$LISTENERS"
      echo "removed route: / :$p"
    else
      echo "no route to remove for port $p"
    fi
    ;;
  port)
    port
    ;;
  status)
    p="$(port)"
    if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${p}/"; then
      state=up
    else
      state=down
    fi
    if have_route "$p"; then
      route=present
    else
      route=missing
    fi
    echo "playwright dashboard: port=$p daemon=$state route=$route"
    ;;
  *)
    echo "usage: playwright-dashboard [add|remove|port|status]" >&2
    exit 2
    ;;
esac
