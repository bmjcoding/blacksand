# shellcheck shell=bash
# Shared by T3 Blackout's host setup scripts (scripts/add-phone-service.sh,
# scripts/enable-screen-sharing.sh and the Screen Sharing check installed from
# it): sourced, not run, as root (sudo; tailscaled's LocalAPI takes writes from
# root only). Output, launchd jobs, tag names, and Tailscale.
#
# Tailscale is asked through tailscaled's LocalAPI directly, never through the
# tailscale command, and every request has a deadline: a daemon that accepts and
# never answers is a failed request, not a stuck caller. A Serve change is
# atomic: the configuration is read with its ETag, checked, and written back with
# If-Match, so a change by anyone else in between makes tailscaled refuse the
# write (412) instead of losing theirs; then it's read again. No failed or
# cut-short answer (curl's, the JSON parser's) is ever taken for "nothing there".

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
oneline() { local text="$*"; echo "${text//$'\n'/ }"; }

# Tag names for --print-policy, which puts them into JSON as they are.
check_tags() {
  local tag
  for tag in "$@"; do [[ $tag =~ ^tag:[A-Za-z0-9-]+$ ]] || die "$tag isn't a tag name (tag:letters-digits-dashes)"; done
}

# ------------------------------------------------------------------ launchd --

# A launchd plist written whole: rendered by "$@", validated, 644 (root's, as
# root makes it in a root folder).
write_plist() {
  local file="$1" tmp
  shift
  tmp="$(mktemp "${file%/*}/.t3blackout.XXXXXX")"
  "$@" >"$tmp"
  plutil -lint -s "$tmp" || { rm -f "$tmp"; die "$file didn't validate"; }
  chmod 644 "$tmp"
  mv -f "$tmp" "$file"
}

loaded() { launchctl print "system/$1" >/dev/null 2>&1; }

# A system job unloaded, once launchd has let go of it (up to 10 s). Status 1
# says why it isn't.
job_unload() {
  local label="$1" i out=""
  loaded "$label" || return 0
  out="$(launchctl bootout "system/$label" 2>&1)" || true
  for ((i = 0; i < 20; i++)); do
    loaded "$label" || return 0
    sleep 0.5
  done
  echo "launchd still has $label 10 s after bootout ($(oneline "$out")); see: sudo launchctl print system/$label"
  return 1
}

# A system job loaded. launchd answers a bootstrap of a job it's still tearing
# down with "5: Input/output error": up to 5 tries, 1 s apart.
job_load() {
  local label="$1" plist="$2" i out=""
  out="$(launchctl enable "system/$label" 2>&1)" || { echo "launchctl enable $label: $(oneline "$out")"; return 1; }
  for i in 1 2 3 4 5; do
    out="$(launchctl bootstrap system "$plist" 2>&1)" && return 0
    loaded "$label" && return 0
    [[ $i == 5 ]] || sleep 1
  done
  echo "launchctl bootstrap $plist failed 5 times: $(oneline "$out"); see: sudo launchctl print system/$label"
  return 1
}

# ---------------------------------------------------------------- tailscale --

# tailscaled's LocalAPI socket: the open-source daemon's (guide section 2.2).
TS_SOCKET="${T3BLACKOUT_TAILSCALED_SOCKET:-/var/run/tailscaled.socket}"
TS_TIMEOUT="${T3BLACKOUT_TAILSCALE_TIMEOUT:-10}"

tailscaled_up() { [[ -S $TS_SOCKET ]]; }

# A LocalAPI request within the deadline: GET <path>; or, with $2, a POST of $2
# that tailscaled takes only while its configuration's ETag is $3 (If-Match).
# The answer: LAPI_CODE (HTTP status), LAPI_ETAG, LAPI_BODY. Status 1 when
# tailscaled didn't answer.
localapi() {
  local out args=(-sS --max-time "$TS_TIMEOUT" --unix-socket "$TS_SOCKET" -w '\n%{http_code} %header{etag}')
  LAPI_CODE="" LAPI_ETAG="" LAPI_BODY=""
  tailscaled_up || return 1
  (($# == 1)) || args+=(-X POST -H 'Content-Type: application/json' -H "If-Match: $3" --data-binary @-)
  out="$(printf '%s' "${2:-}" | curl "${args[@]}" "http://local-tailscaled.sock$1" 2>/dev/null)" || return 1
  LAPI_BODY="${out%$'\n'*}"
  out="${out##*$'\n'}"
  LAPI_CODE="${out%% *}" LAPI_ETAG="${out#* }"
}

# The JSON work, in macOS's own JavaScript (osascript), not a package. Each mode
# prints "invalid" for JSON it can't read.
#   status <status JSON> dns|https|ips: the node's MagicDNS name; whether the
#     tailnet lets it get HTTPS certificates (yes/no/unknown); its tailnet
#     addresses, one per line, lowercase
#   check <config> <kind> <host:port> <target>, kind web (HTTPS on host:port →
#     the target URL) or tcp (raw TCP on the port → host:port):
#     present        the port maps to the target, and only to it, in the
#                    background, with no foreground session on that port
#     free           nothing uses the port, background or foreground
#     funnel <where> Funnel is on somewhere on this node
#     taken <what>   the port serves something else
#   with | without <config> <kind> <host:port> <target>: the configuration with
#     the mapping added, or the port's background handlers removed
#   release <config> <dns> <target>: without every background HTTPS mapping on
#     <dns>, any port, that is exactly "with web"'s to <target>
#   port <config> <kind> <target>: the port that maps only to the target
#   inventory <config> <port> <ports>: three lines. The background handler on TCP
#     <port>: none, "tcp <target>" (a TCP forward and nothing else) or "other
#     <what>". Every other handler, in any scope (background, foreground
#     sessions, services) and of either kind (TCP forwards, web proxies), whose
#     target mentions one of <ports> (comma-separated): "; "-separated, empty
#     for none. Then "end", so a cut-short answer is never an empty one. A
#     target mentions a port when the number appears in it with no digit on
#     either side (leading zeros allowed), whatever surrounds it: host, scheme,
#     path, query.
JXA_SERVE='function parse(text) {
  if (text === "" || text === "null") return {};
  try { const value = JSON.parse(text); return value === null ? {} : value && typeof value === "object" && !Array.isArray(value) ? value : null; } catch (e) { return null; }
}
function canon(value) {
  if (Array.isArray(value)) return "[" + value.map(canon).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canon(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
function portOf(hostPort) { return hostPort.slice(hostPort.lastIndexOf(":") + 1); }
function webKeys(config, port) { return Object.keys(config.Web || {}).filter((key) => portOf(key) === port); }
function scopes(config) {
  return [["", config]].concat(
    Object.entries(config.Foreground || {}).map(([id, c]) => ["foreground session " + id + ": ", c]),
    Object.entries(config.Services || {}).map(([id, c]) => ["service " + id + ": ", c])).filter(([, c]) => c && typeof c === "object");
}
function funnels(config) {
  const on = [];
  for (const [, c] of scopes(config)) for (const key of Object.keys(c.AllowFunnel || {})) if (c.AllowFunnel[key]) on.push(key);
  return on;
}
function mapping(kind, hostPort, target) {
  if (kind === "web") return { tcp: { HTTPS: true }, web: { [hostPort]: { Handlers: { "/": { Proxy: target } } } } };
  return { tcp: { TCPForward: target }, web: {} };
}
function ours(config, kind, hostPort, target) {
  const port = portOf(hostPort);
  const want = mapping(kind, hostPort, target);
  if (canon((config.TCP || {})[port]) !== canon(want.tcp)) return false;
  const keys = webKeys(config, port);
  if (kind === "web") return keys.length === 1 && keys[0] === hostPort && canon(config.Web[hostPort]) === canon(want.web[hostPort]);
  return keys.length === 0;
}
function check(config, kind, hostPort, target) {
  const port = portOf(hostPort);
  const on = funnels(config);
  if (on.length) return "funnel " + on.join(",");
  for (const [id, c] of Object.entries(config.Foreground || {})) {
    if (c && typeof c === "object" && ((c.TCP || {})[port] || webKeys(c, port).length)) return "taken " + JSON.stringify({ foregroundSession: id });
  }
  if (!(config.TCP || {})[port] && !webKeys(config, port).length) return "free";
  if (ours(config, kind, hostPort, target)) return "present";
  return "taken " + JSON.stringify({ tcp: (config.TCP || {})[port] || null, web: webKeys(config, port) });
}
function edited(config, kind, hostPort, target, add) {
  const next = JSON.parse(JSON.stringify(config));
  const port = portOf(hostPort);
  const want = mapping(kind, hostPort, target);
  next.TCP = Object.assign({}, next.TCP);
  next.Web = Object.assign({}, next.Web);
  delete next.TCP[port];
  for (const key of webKeys(next, port)) delete next.Web[key];
  if (add) {
    next.TCP[port] = want.tcp;
    Object.assign(next.Web, want.web);
  }
  for (const key of ["TCP", "Web"]) if (!Object.keys(next[key]).length) delete next[key];
  return JSON.stringify(next);
}
function released(config, dns, target) {
  let next = config;
  for (const port of Object.keys(config.TCP || {})) {
    if (ours(next, "web", dns + ":" + port, target)) next = JSON.parse(edited(next, "web", dns + ":" + port, target, false));
  }
  return JSON.stringify(next);
}
function mentions(target, ports) {
  const text = typeof target === "string" ? target : JSON.stringify(target);
  return ports.some((port) => new RegExp("(^|[^0-9])0*" + port + "([^0-9]|$)").test(text));
}
function inventory(config, port, list) {
  const ports = String(list).split(",").filter(Boolean);
  const others = [];
  for (const [label, c] of scopes(config)) {
    for (const [p, h] of Object.entries(c.TCP || {})) {
      if (label === "" && p === port) continue;
      if (h && typeof h === "object" && h.TCPForward !== undefined && mentions(h.TCPForward, ports)) others.push(label + "TCP " + p + " to " + h.TCPForward);
    }
    for (const [hostPort, w] of Object.entries(c.Web || {})) {
      for (const [route, h] of Object.entries((w && w.Handlers) || {})) {
        if (h && typeof h === "object" && h.Proxy !== undefined && mentions(h.Proxy, ports)) others.push(label + hostPort + route + " to " + h.Proxy);
      }
    }
  }
  const own = (config.TCP || {})[port];
  const web = webKeys(config, port);
  let main = "none";
  if (own !== undefined || web.length) {
    main = own && typeof own === "object" && Object.keys(own).length === 1 && typeof own.TCPForward === "string" && !web.length
      ? "tcp " + own.TCPForward
      : "other " + JSON.stringify({ tcp: own === undefined ? null : own, web: web });
  }
  return [main, others.join("; "), "end"].join("\n");
}
function run(argv) {
  const mode = argv[0];
  if (mode === "status") {
    const status = parse(argv[1]);
    if (!status) return "invalid";
    const self = status.Self || {};
    if (argv[2] === "dns") return String(self.DNSName || "").replace(/\.$/, "");
    if (argv[2] === "ips") return (Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : []).map((ip) => String(ip).toLowerCase()).join("\n");
    const caps = self.CapMap;
    if (!caps || typeof caps !== "object") return "unknown";
    return Object.prototype.hasOwnProperty.call(caps, "https") ? "yes" : "no";
  }
  const config = parse(argv[1]);
  if (!config) return "invalid";
  if (mode === "check") return check(config, argv[2], argv[3], argv[4]);
  if (mode === "inventory") return inventory(config, argv[2], argv[3]);
  if (mode === "with" || mode === "without") return edited(config, argv[2], argv[3], argv[4], mode === "with");
  if (mode === "release") return released(config, argv[2], argv[3]);
  if (mode === "port") {
    const ports = argv[2] === "web" ? Object.keys(config.Web || {}).map((key) => [key, portOf(key)]) : Object.keys(config.TCP || {}).map((port) => ["x:" + port, port]);
    for (const [hostPort, port] of ports) if (check(config, argv[2], hostPort, argv[3]) === "present") return port;
    return "";
  }
  return "invalid";
}'
jxa() { /usr/bin/osascript -l JavaScript - "$@" <<<"$JXA_SERVE"; }

# A configuration from jxa with|without|release: a JSON object, or status 1.
serve_edit() {
  local out
  out="$(jxa "$@")" && [[ $out == "{"*"}" ]] || return 1
  printf '%s' "$out"
}

# jxa inventory of configuration $1 (TCP $2, ports $3), checked whole: the two
# lines before "end". Status 1 for any other answer.
inventory_of() {
  local out main others end
  out="$(jxa inventory "$1" "$2" "$3")" || return 1
  { IFS= read -r main && IFS= read -r others && IFS= read -r end; } <<<"$out" || return 1
  [[ $end == end && ($main == none || $main == "tcp "?* || $main == "other "?*) ]] || return 1
  printf '%s\n%s\n' "$main" "$others"
}

# This node's status JSON, or status 1 if it can't be had in time.
tailnet_status() { localapi /localapi/v0/status && [[ $LAPI_CODE == 200 ]] && printf '%s' "$LAPI_BODY"; }

# This node's MagicDNS name (status 1, and a warning, when Tailscale isn't up);
# with "https", also that the tailnet can issue it certificates.
# shellcheck disable=SC2120 # add-phone-service.sh, which sources this, passes "https"
tailnet_name() {
  local status dns
  status="$(tailnet_status)" || { warn "tailscaled didn't answer ($TS_SOCKET, ${TS_TIMEOUT}s): is it running and this Mac logged in?"; return 1; }
  dns="$(jxa status "$status" dns)" && [[ $dns != invalid ]] || { warn "couldn't read this Mac's tailnet status"; return 1; }
  [[ -n $dns ]] || { warn "this Mac has no MagicDNS name: turn MagicDNS on (admin console → DNS)"; return 1; }
  if [[ ${1:-} == https && "$(jxa status "$status" https)" == no ]]; then
    warn "the tailnet can't issue HTTPS certificates yet: admin console → DNS → HTTPS Certificates → Enable. The certificate publishes $dns in public Certificate Transparency logs."
    return 1
  fi
  echo "$dns"
}

# This node's tailnet addresses, one per line, lowercase; status 1 if none, or if
# tailscaled doesn't answer in time.
tailnet_ips() {
  local status ips
  status="$(tailnet_status)" && ips="$(jxa status "$status" ips)" && [[ -n $ips && $ips != invalid ]] || return 1
  echo "$ips"
}

# Why packets from the local network could be addressed to this Mac's tailnet
# addresses, or nothing (status 1). Tailscale Serve listens on those addresses
# with ordinary kernel sockets (ipn/ipnlocal/serve.go), on the utun interface
# that carries them; the kernel delivers a packet for an address on another
# interface only with forwarding on, or with the weak host model:
#   net.inet.ip.forwarding, net.inet6.ip6.forwarding      must be 0
#   net.inet.ip.check_interface, net.inet6.ip6.check_interface
#     0 weak host model: refused
#     1 hybrid (macOS's default): strict for utun and IPsec interfaces, accepted
#     2 strict on every interface: accepted
# A setting that can't be read is refused too. Read, never changed.
forwarding_problem() {
  local setting value
  for setting in net.inet.ip.forwarding net.inet6.ip6.forwarding; do
    value="$(sysctl -n "$setting" 2>/dev/null || echo unreadable)"
    [[ $value == 0 ]] ||
      { echo "$setting is $value, not 0 (forwarding on): your local network could reach Tailscale Serve's listeners on this Mac's tailnet addresses"; return 0; }
  done
  for setting in net.inet.ip.check_interface net.inet6.ip6.check_interface; do
    value="$(sysctl -n "$setting" 2>/dev/null || echo unreadable)"
    case "$value" in
      1 | 2) ;;
      0) echo "$setting is 0 (weak host model): your local network could reach Tailscale Serve's listeners on this Mac's tailnet addresses; 1 (macOS's default, strict for utun) or 2 (strict everywhere) is needed"; return 0 ;;
      *) echo "$setting is $value, not 1 or 2: can't tell whether your local network could reach Tailscale Serve's listeners"; return 0 ;;
    esac
  done
  return 1
}

# Serve's configuration (SERVE_CONFIG) and its ETag (SERVE_ETAG). Status 1 when
# either can't be had.
serve_get() {
  localapi /localapi/v0/serve-config && [[ $LAPI_CODE == 200 && -n $LAPI_ETAG ]] || return 1
  SERVE_CONFIG="$LAPI_BODY" SERVE_ETAG="$LAPI_ETAG"
}

# $1 written as Serve's configuration if it's still the one serve_get read.
# Status 0 written, 2 refused because it changed since (412), 1 any other failure.
serve_post() {
  localapi /localapi/v0/serve-config "$1" "$SERVE_ETAG" || return 1
  case "$LAPI_CODE" in
    200) return 0 ;;
    412) return 2 ;;
    *) return 1 ;;
  esac
}

# --------------------------------------------- the phone's HTTPS mappings --

# The port Serve maps to the target already (kind web or tcp), or nothing.
serve_port_of() {
  local found
  serve_get && found="$(jxa port "$SERVE_CONFIG" "$1" "$2")" && [[ $found != invalid ]] || return 1
  echo "$found"
}

# The mapping (kind, host:port, target) added unless it's there; a die, changing
# nothing, when the port is in use, Funnel is on, or the configuration can't be
# read or changed under it. Status 0 once it's read back in effect.
serve_add() {
  local kind="$1" hostPort="$2" target="$3" verdict new status=0
  serve_get || die "couldn't read Tailscale Serve's configuration from tailscaled ($TS_SOCKET); nothing changed. The guide's tailscaled (section 2.2) must be running."
  verdict="$(jxa check "$SERVE_CONFIG" "$kind" "$hostPort" "$target")" || verdict="the parser failed"
  case "$verdict" in
    present) return 0 ;;
    free) ;;
    funnel*) die "Funnel is on for ${verdict#funnel } (public on the Internet); nothing is added to a node with Funnel on. Turn it off (tailscale funnel reset, or the funnel nodeAttr in the policy), then rerun." ;;
    taken*) die "Tailscale Serve's port ${hostPort##*:} is in use (${verdict#taken }); pick another port, or end the foreground tailscale serve session holding it" ;;
    *) die "couldn't read Tailscale Serve's configuration ($verdict); nothing changed" ;;
  esac
  new="$(serve_edit with "$SERVE_CONFIG" "$kind" "$hostPort" "$target")" || die "couldn't work out Tailscale Serve's new configuration; nothing changed"
  serve_post "$new" || status=$?
  case "$status" in
    0) ;;
    2) die "Tailscale Serve's configuration changed while this checked it (another client wrote it); tailscaled refused the write, nothing changed. Run this again." ;;
    *) die "tailscaled refused the Serve change: $(oneline "$LAPI_BODY")" ;;
  esac
  serve_get && verdict="$(jxa check "$SERVE_CONFIG" "$kind" "$hostPort" "$target")" && [[ $verdict == present ]] ||
    die "Tailscale Serve doesn't show the mapping in effect after the change; check: tailscale serve status"
}

# What in configuration $1 mentions port $2 (inventory's rule): "; "-separated,
# empty for none. Status 1 if the parser failed.
serve_mentions() {
  local inventory
  inventory="$(inventory_of "$1" 0 "$2")" || return 1
  [[ $inventory != *$'\n'* ]] || printf '%s' "${inventory#*$'\n'}"
}

# A phone's HTTPS mappings to its server on port $2 removed (every background one
# on this node's name $1 exactly serve_add's to http://127.0.0.1:$2, on any
# port), atomically, and the configuration read back. Funnel and other ports'
# handlers don't stop it; any other handler mentioning the port does, before
# anything is written. Status 0 only once nothing read back mentions the port.
# An empty $1 is looked up only when there's a mapping to remove, so a server
# that never had one goes even while this Mac isn't signed in to Tailscale.
serve_remove() {
  local dns="$1" port="$2" new before after status=0
  serve_get || die "couldn't read Tailscale Serve's configuration; nothing was removed (tailscale serve status)"
  before="$(serve_mentions "$SERVE_CONFIG" "$port")" || die "couldn't read Tailscale Serve's configuration (the parser failed); nothing was removed"
  if [[ -z $before ]]; then
    say "Tailscale Serve: nothing forwards to 127.0.0.1:$port"
    return 0
  fi
  # This Mac's tailnet name is only needed once there's a mapping to take out.
  [[ -n $dns ]] || dns="$(tailnet_name)" || die "Tailscale's status can't be read (above), so the Serve mapping to 127.0.0.1:$port can't be removed; nothing was removed"
  new="$(serve_edit release "$SERVE_CONFIG" "$dns" "http://127.0.0.1:$port")" || die "couldn't work out Tailscale Serve's new configuration; nothing was removed"
  after="$(serve_mentions "$new" "$port")" || die "couldn't read Tailscale Serve's configuration (the parser failed); nothing was removed"
  [[ -z $after ]] || die "Tailscale Serve has handlers this didn't make that mention 127.0.0.1:$port ($after); nothing was removed. End them (tailscale serve status), then rerun"
  serve_post "$new" || status=$?
  case "$status" in
    0) ;;
    2) die "Tailscale Serve's configuration changed while this checked it; nothing removed. Run this again." ;;
    *) die "tailscaled refused the Serve change; nothing removed" ;;
  esac
  serve_get || die "couldn't read Tailscale Serve's configuration back after the removal, so whether anything still forwards to 127.0.0.1:$port is unknown; run this again"
  after="$(serve_mentions "$SERVE_CONFIG" "$port")" || die "couldn't read Tailscale Serve's configuration back after the removal (the parser failed); run this again"
  [[ -z $after ]] || die "Tailscale Serve still has handlers that mention 127.0.0.1:$port after the removal ($after); run this again"
  say "Tailscale Serve: removed $before"
}

# --------------------------------------- Screen Sharing's TCP forward --
# These never die: status 1 with the reason on stdout, for the check to act on.

# The inventory (inventory_of) of Serve's configuration for TCP $1 and the ports
# $2, or status 1 and why.
serve_inventory() {
  serve_get || { echo "tailscaled didn't give its Serve configuration ($TS_SOCKET, ${TS_TIMEOUT}s)"; return 1; }
  inventory_of "$SERVE_CONFIG" "$1" "$2" || { echo "tailscaled's Serve configuration couldn't be read (the parser failed)"; return 1; }
}

# "none", or a TCP forward to the target $1, as the inventory says it.
handler_of() { if [[ $1 == none ]]; then echo none; else echo "tcp $1"; fi; }

# Serve's background TCP $1 handler changed from exactly $2 to $3 ("none", or a
# TCP forward's target) while no other handler mentions the ports $4, and nothing
# else changed: written atomically (a 412 read again and retried, up to 3 times,
# still only from $2), then read back. Status 1 says why it wasn't.
serve_tcp_set() {
  local port="$1" from="$2" to="$3" ports="$4" inventory new edit=with status=1 i
  [[ $to != none ]] || edit=without
  for i in 1 2 3; do
    serve_get || { echo "tailscaled didn't give its Serve configuration ($TS_SOCKET, ${TS_TIMEOUT}s); TCP $port left as it is"; return 1; }
    inventory="$(inventory_of "$SERVE_CONFIG" "$port" "$ports")" || { echo "tailscaled's Serve configuration couldn't be read (the parser failed); TCP $port left as it is"; return 1; }
    [[ $inventory == "$(handler_of "$from")" ]] ||
      { echo "Tailscale Serve's TCP $port is ${inventory/$'\n'/, and these mention TCP $ports: }, not $(handler_of "$from") alone; left as it is"; return 1; }
    new="$(serve_edit "$edit" "$SERVE_CONFIG" tcp "x:$port" "$to")" || { echo "couldn't work out Tailscale Serve's new configuration; TCP $port left as it is"; return 1; }
    status=0
    serve_post "$new" || status=$?
    ((status == 2)) || break
  done
  case "$status" in
    0) ;;
    2) echo "Tailscale Serve's configuration kept changing under this (refused 3 times); TCP $port left as it was"; return 1 ;;
    *) echo "tailscaled refused the Serve change ($(oneline "$LAPI_BODY"))"; return 1 ;;
  esac
  inventory="$(serve_inventory "$port" "$ports")" || { echo "$inventory, after the change"; return 1; }
  [[ $inventory == "$(handler_of "$to")" ]] ||
    { echo "Tailscale Serve shows TCP $port as ${inventory/$'\n'/, and these mention TCP $ports: } after the change, not $(handler_of "$to") alone"; return 1; }
}
