#!/usr/bin/env bash
# Screen Sharing on the always-on host, for your admin account only: reachable
# from this Mac's loopback and, through Tailscale Serve, from the devices your
# tailnet policy allows; never from your local network
# (tooling/blacksand-t3/docs/remote-access/screen-sharing.md). Run with sudo from that admin account:
#
#   sudo scripts/enable-screen-sharing.sh               # set up and on, or put back
#   sudo scripts/enable-screen-sharing.sh --no-serve    # the same, loopback only (an SSH tunnel)
#   sudo scripts/enable-screen-sharing.sh --off | --on | --status
#   sudo scripts/enable-screen-sharing.sh --uninstall   # off, and everything this added removed
#   scripts/enable-screen-sharing.sh --print-policy     # the Tailscale grant (no sudo)
#
# Off the local network. macOS's own job, com.apple.screensharing, listens on
# every interface; only a firewall could narrow that, and a firewall this host
# depends on is one more way to be locked out of it, so there's none (nothing
# here touches pf, sshd or a firewall). Instead the same screensharingd runs under
# the same label (macOS runs it under no other) from a plist of this script's,
# made from Apple's, whose only socket is localhost:15900: 127.0.0.1 and ::1 (it
# crashes on one family). That plist lives outside launchd's LaunchDaemons
# folders, and the label's switch (launchctl disable, which boot and System
# Settings go by) stays off; only the check below loads the plist, switching the
# label on for that one bootstrap. Which plist the loaded job came from tells the
# two apart. (A crash or power loss in that bootstrap's moment leaves the switch
# on: the next boot starts Apple's version until the boot-time check unloads it.)
#
# Over the tailnet. Tailscale Serve forwards the tailnet's TCP 5900 to
# 127.0.0.1:15900, but only while Screen Sharing is verified to hold that port:
# any program on this Mac may listen on a free high port, and one on 15900 would
# get what the desktop sends (a fake sign-in prompt, say). Two root launchd jobs,
# loaded at boot, hold a port each and serve nothing (each connection goes to
# /usr/bin/true, as nobody): hold (dev.blacksand.screensharing-hold) has 15900
# whenever Screen Sharing is off, park (dev.blacksand.screensharing-park) 15901
# always. While Screen Sharing is off the forward points at 15901 ("parked"). Every
# change of 15900's holder happens while the forward is parked, read back from
# tailscaled; then the new holder is verified (root's launchd, or root's
# screensharingd running Apple's file, on both families) before the forward
# points at it. A forward that can't be read back as parked (tailscaled not
# answering, or another Serve handler mentioning 15900 or 15901) means no port
# changes hands. Parked, not removed: TCP 5900 on the tailnet stays tailscaled's.
#
# The check (dev.blacksand.screen-sharing-check: root, at boot and every minute)
# keeps Apple's version unloaded and the switch off, and keeps Screen Sharing on
# only while it's wanted and every rule holds: exactly the admin account you ran
# this from may sign in (by name and GeneratedUID, nobody else, no groups); no VNC
# password; Remote Management off; IP forwarding off and the host model hybrid or
# strict (so your local network can't reach Serve's listeners); TCP 5900 open only
# by root's tailscaled on this Mac's tailnet addresses. A rule broken, or one it
# can't read, turns Screen Sharing off. Checks run one at a time (under a lock
# only root can take) in a process group of their own, stopped after 50 s; one
# stopped, or unable to run, turns Screen Sharing off too (within 30 s). Setup,
# --on, --off and --uninstall change what's wanted and run the same check.
#
# Setup succeeds once screensharingd answers on loopback (its RFB greeting) and
# its own check-in line, if there is one, says macOS lets it capture the screen
# and post input: denied (a black screen that takes no input) fails, with the
# System Settings step that should grant it; no line to go by only warns, and
# setup still succeeds.
#
# Standard mode only: Serve forwards TCP, and High Performance mode needs UDP.
# System Settings shows Screen Sharing as off: its switch, which stays off.

set -euo pipefail
umask 077

# shellcheck source=scripts/host-common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/host-common.sh"

LABEL=com.apple.screensharing
APPLE_PLIST=/System/Library/LaunchDaemons/$LABEL.plist
OWN_DIR="/Library/Application Support/blacksand"
OWN_PLIST="$OWN_DIR/$LABEL.plist"
HOLD_LABEL=dev.blacksand.screensharing-hold
HOLD_PLIST=/Library/LaunchDaemons/$HOLD_LABEL.plist
PARK_LABEL=dev.blacksand.screensharing-park
PARK_PLIST=/Library/LaunchDaemons/$PARK_LABEL.plist
CHECK_LABEL=dev.blacksand.screen-sharing-check
CHECK_PLIST=/Library/LaunchDaemons/$CHECK_LABEL.plist
HELPER_DIR=/usr/local/libexec/blacksand
CHECK=$HELPER_DIR/screen-sharing-check
CHECK_LOG=/var/log/$CHECK_LABEL.log
# Kept across restarts: who may sign in ("name uid GeneratedUID"); that Screen
# Sharing should be on; and Serve's part. That last is absent with --no-serve
# (nothing here reads or writes Serve then), empty until this setup first writes
# a forward, and "forward" from just before that write on: then tailscaled's saved
# configuration may hold one, so tailscaled not running is never "nothing
# there". Until the next restart: the last failed check's reason, and the lock.
USER_FILE=/var/db/dev.blacksand.screensharing.user
WANTED=/var/db/dev.blacksand.screensharing.wanted
SERVE=/var/db/dev.blacksand.screensharing.serve
FAILING=/var/run/$CHECK_LABEL.failing
LOCK=/var/run/$CHECK_LABEL.flock
ACCESS_GROUP=com.apple.access_screensharing
AGENT_GROUP=blacksand-agents
VNC_PASSWORD_FILE=/Library/Preferences/com.apple.VNCSettings.txt
RM_PREFS=/Library/Preferences/com.apple.RemoteManagement
RM_LAUNCHD="/Library/Application Support/Apple/Remote Desktop/RemoteManagement.launchd"
ARD_KICKSTART=/System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart
LOG_TOOL=/usr/bin/log
PORT=5900          # the tailnet's: Serve's listener
BACKEND_PORT=15900 # Screen Sharing's, or the hold job's
PARK_PORT=15901    # the parking job's
LIVE=127.0.0.1:$BACKEND_PORT
PARKED=127.0.0.1:$PARK_PORT
CHECK_DEADLINE=50
STOP_DEADLINE=30
HOST_TAG=tag:t3b-host
DESKTOP_TAG=tag:t3b-desktop
PHONE_TAG=tag:t3b-phone

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# A group's attribute values (dscl: status 0 and nothing for an attribute it
# lacks); status 1 when dscl fails.
group_values() { local out; out="$(dscl . -read "/Groups/$1" "$2" 2>/dev/null)" || return 1; sed "1s/^$2://" <<<"$out"; }
# Whether $1 is an agent account: dseditgroup's 67 (not a member) and 64 (no such
# group yet) are the only no.
is_agent() { local status=0; dseditgroup -o checkmember -m "$1" "$AGENT_GROUP" >/dev/null 2>&1 || status=$?; [[ $status != 67 && $status != 64 ]]; }
guid_of() { dscl . -read "/Users/$1" GeneratedUID 2>/dev/null | awk '{print $2}'; }

# ----------------------------------------------------------------- render --

# This script's plist, made from Apple's (so a macOS update's changes come along):
# Apple's label, not disabled by default, and one socket, localhost:15900, with no
# family and no Bonjour advertisement: launchd makes it 127.0.0.1 and ::1. Into
# $1; status 1 if plutil can't make or confirm it.
render_own_plist() {
  local out="$1" socket="{\"Listener\":{\"SockNodeName\":\"localhost\",\"SockServiceName\":\"$BACKEND_PORT\"}}"
  cp "$APPLE_PLIST" "$out" &&
    plutil -convert xml1 "$out" &&
    { plutil -remove Disabled "$out" 2>/dev/null || true; } &&
    plutil -replace Sockets -json "$socket" "$out" &&
    plutil -lint -s "$out" &&
    [[ "$(plutil -extract Sockets json -o - "$out")" == "$socket" && "$(plutil -extract Label raw -o - "$out")" == "$LABEL" ]]
}

# A job that only holds a port ($1 its label, $2 the port): launchd's socket on
# localhost (127.0.0.1 and ::1), each connection accepted by launchd and handed
# to /usr/bin/true as nobody (inetd style, launchd.plist(5)), which closes it.
render_hold_plist() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$1</string>
  <key>Program</key>
  <string>/usr/bin/true</string>
  <key>UserName</key>
  <string>nobody</string>
  <key>inetdCompatibility</key>
  <dict>
    <key>Wait</key>
    <false/>
  </dict>
  <key>Sockets</key>
  <dict>
    <key>Listener</key>
    <dict>
      <key>SockNodeName</key>
      <string>localhost</string>
      <key>SockServiceName</key>
      <string>$2</string>
    </dict>
  </dict>
</dict>
</plist>
EOF
}

render_check_plist() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$CHECK_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$CHECK</string>
    <string>check</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>$CHECK_LOG</string>
  <key>StandardErrorPath</key>
  <string>$CHECK_LOG</string>
</dict>
</plist>
EOF
}

# The grant and tests to merge into the tailnet policy: the desktop Mac may open
# TCP 5900 on the host, nothing else gains anything, and nobody else may open it.
# Self-contained: the phone's tag, which a test names, is declared exactly as the
# phone's fragment declares it (scripts/add-phone-service.sh), so either fragment
# works alone and merging both adds it once.
print_policy() {
  cat <<EOF
{
  // blacksand-t3 Screen Sharing (scripts/enable-screen-sharing.sh): TCP only.
  "tagOwners": {
    "$PHONE_TAG": ["autogroup:admin"]
  },
  "grants": [
    { "src": ["$DESKTOP_TAG"], "dst": ["$HOST_TAG"], "ip": ["tcp:5900"] }
  ],
  "tests": [
    { "src": "$DESKTOP_TAG", "proto": "tcp", "accept": ["$HOST_TAG:5900"], "deny": ["$HOST_TAG:5901", "$HOST_TAG:3283"] },
    { "src": "$DESKTOP_TAG", "proto": "udp", "deny": ["$HOST_TAG:5900", "$HOST_TAG:5901", "$HOST_TAG:5902"] },
    { "src": "$HOST_TAG", "deny": ["$DESKTOP_TAG:5900"] },
    { "src": "$PHONE_TAG", "deny": ["$HOST_TAG:5900"] }
  ]
}
EOF
}

# ------------------------------------------------------------------ facts --
# Each read is a fact or a reason; a tool that fails is never a safe answer.

# The plist the loaded com.apple.screensharing came from (launchctl print's
# top-level "path = …" line), or nothing.
loaded_path() { { launchctl print "system/$LABEL" 2>/dev/null || true; } | awk 'index($0, "\tpath = ") == 1 { print substr($0, 9); exit }'; }
loaded_from() { local path; path="$(loaded_path)"; echo "${path:-an unnamed plist (launchctl print shows no path)}"; }
# Loaded from this script's plist (launchd may show it under /private).
ours_loaded() { local path; path="$(loaded_path)"; [[ -n $path && ($path == "$OWN_PLIST" || $path == "/private$OWN_PLIST") ]]; }
# Loaded from anything else: Apple's every-interface plist, or one unnamed.
apples_loaded() { loaded "$LABEL" && ! ours_loaded; }
switched_off() { local out; out="$(launchctl print-disabled system 2>/dev/null)" && grep -Eq "\"$1\" => (disabled|true)" <<<"$out"; }
# On when ARDAgent runs, launchd's switch for it says so, or pgrep fails (its
# status 1 is the only "not running").
remote_management_on() { local status=0; pgrep -x ARDAgent >/dev/null 2>&1 || status=$?; [[ $status != 1 ]] || grep -qs enabled "$RM_LAUNCHD"; }

# Who listens on TCP $1, one socket a line, "pid<TAB>uid<TAB>command<TAB>address"
# ("1	0	launchd	127.0.0.1:15900"), as root's lsof sees them; nothing when
# nobody does (lsof's silent status 1). Status 1 when lsof failed.
listeners_on() {
  local out status=0
  out="$(lsof +c 0 -nP -w -iTCP:"$1" -sTCP:LISTEN -F pcun 2>&1)" || status=$?
  [[ $status == 0 || ($status == 1 && -z $out) ]] || return 1
  [[ -z $out ]] || awk -v OFS='\t' '/^p/ { pid = substr($0, 2); uid = ""; command = "" } /^c/ { command = substr($0, 2) } /^u/ { uid = substr($0, 2) } /^n/ { print pid, uid, command, substr($0, 2) }' <<<"$out" | sort -u
}
# The same as "command address" words, for --status and messages.
listeners_text() {
  local lines
  lines="$(listeners_on "$1")" || { echo "(lsof couldn't list them)"; return 0; }
  [[ -n $lines ]] || { echo nothing; return 0; }
  awk -F '\t' '{ printf "%s%s %s", (NR > 1 ? " " : ""), $3, $4 }' <<<"$lines"
}
# The file a process runs, as the kernel has it (lsof's first txt file): never
# its name or arguments, which it chooses itself.
exe_of() { { lsof -p "$1" -a -d txt -F n 2>/dev/null || true; } | awk '/^n/ { print substr($0, 2); exit }'; }
# The screensharingd this script's job runs (Apple's plist names it).
screensharingd_path() { plutil -extract ProgramArguments.0 raw -o - "$OWN_PLIST" 2>/dev/null || true; }

# Why TCP $1 isn't held as the jobs here hold it, or nothing (status 1): on
# 127.0.0.1 and ::1, both, nowhere else, only by root's launchd (pid 1, which
# holds a job's sockets) or, with $2 "screensharing", root's screensharingd
# running Apple's file (which inherits them). Identity is the process, its user
# and the file it runs; names and answers prove nothing.
port_problem() {
  local port="$1" lines pid uid command addr exe seen=" " allowed="root's launchd"
  [[ ${2:-} != screensharing ]] || allowed="root's launchd or $(screensharingd_path)"
  lines="$(listeners_on "$port")" || { echo "lsof couldn't list who listens on TCP $port"; return 0; }
  [[ -n $lines ]] || { echo "nothing holds TCP $port"; return 0; }
  while IFS=$'\t' read -r pid uid command addr; do
    if [[ $uid != 0 ]]; then
      echo "TCP $port is held on $addr by $command (pid $pid, uid ${uid:-unknown}), not $allowed"
      return 0
    fi
    if [[ $pid != 1 ]]; then
      exe=""
      [[ ${2:-} != screensharing ]] || exe="$(exe_of "$pid")"
      if [[ -z $exe || $exe != "$(screensharingd_path)" ]]; then
        echo "TCP $port is held on $addr by $command (pid $pid, uid 0, running ${exe:-an unknown file}), not $allowed"
        return 0
      fi
    fi
    case "$addr" in
      "127.0.0.1:$port" | "[::1]:$port") seen+="$addr " ;;
      *) echo "TCP $port is open on $addr ($command, pid $pid); only 127.0.0.1 and ::1 may be"; return 0 ;;
    esac
  done <<<"$lines"
  for addr in "127.0.0.1:$port" "[::1]:$port"; do
    [[ $seen == *" $addr "* ]] || { echo "TCP $port isn't held on $addr (127.0.0.1 and ::1 both must be)"; return 0; }
  done
  return 1
}

# Why TCP 5900 is open by something other than root's tailscaled on this Mac's
# own tailnet addresses (Serve's listeners), or nothing (status 1).
foreign_5900() {
  local lines pid uid command addr host ips=""
  lines="$(listeners_on "$PORT")" || { echo "lsof couldn't list who listens on TCP $PORT"; return 0; }
  [[ -n $lines ]] || return 1
  while IFS=$'\t' read -r pid uid command addr; do
    [[ $command == tailscaled && $uid == 0 ]] || { echo "TCP $PORT is open on $addr by $command (pid $pid, uid ${uid:-unknown})"; return 0; }
    if [[ -z $ips ]]; then
      ips="$(tailnet_ips)" ||
        { echo "TCP $PORT is open by tailscaled on $addr, and this Mac's tailnet addresses can't be read to check it (tailscaled didn't answer within ${TS_TIMEOUT}s)"; return 0; }
    fi
    host="${addr%:*}"
    host="${host#[}"
    host="${host%]}"
    grep -qixF -- "$host" <<<"$ips" || { echo "TCP $PORT is open by tailscaled on $addr, not one of this Mac's tailnet addresses"; return 0; }
  done <<<"$lines"
  return 1
}

# Whether something answers RFB ("RFB 003.889") on 127.0.0.1:15900. Whose port
# it is, port_problem says: a greeting alone proves nothing.
rfb_answers() {
  local banner
  banner="$({ nc -G 3 -w 3 127.0.0.1 "$BACKEND_PORT" </dev/null 2>/dev/null || true; } | head -c 12)"
  [[ $banner == "RFB "* ]]
}

# What macOS lets screensharingd do, from the newest check-in line it logged in the
# last $1 (one per connection: "… loginwindow 0 postEventFlag 1 screenCaptureFlag 1"):
# granted (capture and input both 1); denied (either 0 with a user at the
# console: a black screen that takes no input); unknown (no line, or only the
# login window).
capture_state() {
  local since="$1" line flags post capture login
  line="$({ "$LOG_TOOL" show --style compact --last "$since" --predicate 'process == "screensharingd" AND eventMessage CONTAINS "screenCaptureFlag"' 2>/dev/null || true; } | { grep -F screenCaptureFlag || true; } | tail -n 1)"
  [[ -n $line ]] || { echo "unknown (no screensharingd check-in logged in the last $since)"; return 0; }
  flags="$(sed -nE 's/.*postEventFlag ([0-9]+) screenCaptureFlag ([0-9]+).*/\1 \2/p' <<<"$line")"
  login="$(sed -nE 's/.* loginwindow ([0-9]+) .*/\1/p' <<<"$line")"
  read -r post capture <<<"$flags" || true
  if [[ $post == 1 && $capture == 1 ]]; then echo "granted (postEventFlag 1, screenCaptureFlag 1)"
  elif [[ -z $flags || $login != 0 ]]; then echo "unknown (${login:+loginwindow $login, }postEventFlag ${post:-?}, screenCaptureFlag ${capture:-?}: no user session at the console to check against)"
  else echo "denied (postEventFlag $post, screenCaptureFlag $capture)"
  fi
}
CAPTURE_REMEDY="macOS hasn't granted Screen Sharing screen capture and control on this Mac: signing in would show a black screen that takes no input. Once, at the Mac itself: System Settings → General → Sharing, turn Screen Sharing on, wait until it shows as on, turn it off again, then rerun this script. (Not yet confirmed on a real Mac. While it's on, Apple's version listens on every interface, password-protected: do it with the macOS firewall on or the Mac off your local network, before agent accounts exist.)"

# Why Screen Sharing's access list isn't exactly the account recorded at setup,
# or nothing (status 1): that account, unchanged (uid, GeneratedUID), still an
# admin and no agent account, and nobody else, by name (GroupMembership) or GUID
# (GroupMembers), and no groups.
access_problem() {
  local name="" uid="" guid="" member names guids nested
  read -r name uid guid <"$USER_FILE" 2>/dev/null || true
  [[ -n $name && -n $uid && -n $guid ]] || { echo "no account recorded for Screen Sharing ($USER_FILE); rerun the script"; return 0; }
  [[ "$(id -u "$name" 2>/dev/null)" == "$uid" && "$(guid_of "$name")" == "$guid" ]] ||
    { echo "the account $name isn't the one recorded at setup (uid $uid, GeneratedUID $guid)"; return 0; }
  dseditgroup -o checkmember -m "$name" admin >/dev/null 2>&1 || { echo "$name is no longer an admin"; return 0; }
  if is_agent "$name"; then echo "$name is in $AGENT_GROUP (or that can't be checked)"; return 0; fi
  dscl . -read "/Groups/$ACCESS_GROUP" >/dev/null 2>&1 || { echo "Screen Sharing allows every account (no $ACCESS_GROUP list)"; return 0; }
  names="$(group_values "$ACCESS_GROUP" GroupMembership)" && guids="$(group_values "$ACCESS_GROUP" GroupMembers)" &&
    nested="$(group_values "$ACCESS_GROUP" NestedGroups)" || { echo "Screen Sharing's list ($ACCESS_GROUP) can't be read"; return 0; }
  for member in $names; do [[ $member == "$name" ]] || { echo "$member may sign in to Screen Sharing; only $name may"; return 0; }; done
  for member in $guids; do [[ $member == "$guid" ]] || { echo "another account ($member) may sign in to Screen Sharing; only $name may"; return 0; }; done
  [[ -z "$(tr -d '[:space:]' <<<"$nested")" ]] || { echo "Screen Sharing's list includes a group; only $name may sign in"; return 0; }
  [[ " $(xargs <<<"$names") " == *" $name "* || " $(xargs <<<"$guids") " == *" $guid "* ]] || { echo "$name isn't in Screen Sharing's list"; return 0; }
  return 1
}

# Why the sign-in rules don't hold, or nothing (status 1).
policy_problem() {
  access_problem && return 0
  [[ ! -e $VNC_PASSWORD_FILE ]] || { echo "a VNC password is set ($VNC_PASSWORD_FILE)"; return 0; }
  remote_management_on && { echo "Remote Management is on"; return 0; }
  return 1
}

# ------------------------------------------------- Tailscale Serve's forward --

# Serve's TCP 5900 background handler (SV_MAIN: none, "tcp <target>" or "other
# …") and every other handler mentioning 15900 or 15901 (SV_OTHERS), as read
# from tailscaled: SV_STATE read; or absent, when tailscaled isn't running, so
# what it keeps (and restores when it starts) is unknown. Status 1 when it can't
# be read (SV_WHY says why).
serve_read() {
  local out
  SV_STATE=absent SV_MAIN="" SV_OTHERS="" SV_WHY=""
  tailscaled_up || return 0
  out="$(serve_inventory "$PORT" "$BACKEND_PORT,$PARK_PORT")" || { SV_WHY="$out"; return 1; }
  { IFS= read -r SV_MAIN && IFS= read -r SV_OTHERS; } <<<"$out" || true
  SV_STATE="read"
}

# Why what serve_read read isn't parked, or nothing (status 1): TCP 5900 forwards
# to exactly the parking job's port, or nothing does, and nothing else mentions
# either protected port.
not_parked() {
  [[ $SV_STATE == read ]] || { echo "tailscaled isn't running, so the forward it keeps (and restores when it starts) can't be checked"; return 0; }
  [[ -n $SV_OTHERS || ($SV_MAIN != none && $SV_MAIN != "tcp $PARKED") ]] || return 1
  echo "Tailscale Serve isn't parked: TCP $PORT is $SV_MAIN${SV_OTHERS:+, and these mention TCP $BACKEND_PORT or $PARK_PORT: $SV_OTHERS}"
}

# Serve verifiably parked (a setup without Serve always is): this setup's live
# forward moved to the parking job's port (removed if that port isn't verified
# held), read back. Anything else is reported and left alone: status 1, and no
# port may change hands.
serve_park() {
  local why to=$PARKED
  [[ -s $SERVE ]] || return 0
  serve_read || { echo "Tailscale Serve's configuration can't be read ($SV_WHY)"; return 1; }
  why="$(not_parked)" || return 0
  [[ $SV_STATE == read && $SV_MAIN == "tcp $LIVE" && -z $SV_OTHERS ]] || { echo "$why; left as it is (tailscale serve status), so no port changes hands"; return 1; }
  if port_problem "$PARK_PORT" >/dev/null; then to=none; fi
  serve_tcp_set "$PORT" "$LIVE" "$to" "$BACKEND_PORT,$PARK_PORT"
}

# Serve's TCP 5900 forwarded to Screen Sharing (a setup with Serve), from parked
# or nothing, never past another handler mentioning either protected port.
# Without tailscaled running, the next check does it.
serve_live() {
  local from
  [[ -f $SERVE ]] || return 0
  serve_read || { echo "Tailscale Serve's configuration can't be read ($SV_WHY)"; return 1; }
  [[ $SV_STATE == read ]] || return 0
  [[ -z $SV_OTHERS ]] || { echo "Tailscale Serve has handlers mentioning TCP $BACKEND_PORT or $PARK_PORT ($SV_OTHERS); Screen Sharing stays off over Tailscale"; return 1; }
  case "$SV_MAIN" in
    "tcp $LIVE") return 0 ;;
    "tcp $PARKED") from=$PARKED ;;
    none) from=none ;;
    *) echo "Tailscale Serve's TCP $PORT is in use ($SV_MAIN); Screen Sharing stays off over Tailscale"; return 1 ;;
  esac
  [[ -s $SERVE ]] || printf 'forward\n' >"$SERVE" || { echo "couldn't record $SERVE"; return 1; }
  serve_tcp_set "$PORT" "$from" "$LIVE" "$BACKEND_PORT,$PARK_PORT"
}

# ----------------------------------------------------------- the switches --
# Each echoes why, and returns 1, when what it's for isn't so afterwards.

# Screen Sharing's switch off, verified (3 tries).
switch_off() {
  local i out=""
  for i in 1 2 3; do
    switched_off "$LABEL" && return 0
    out="$(launchctl disable "system/$LABEL" 2>&1)" || true
  done
  switched_off "$LABEL" && return 0
  echo "its switch won't go off (launchctl disable $LABEL: $(oneline "${out:-no error}")): a restart would start Apple's every-interface version"
  return 1
}

# Apple's every-interface version not loaded, and the switch off.
apple_off() {
  local why="" out
  if apples_loaded; then out="$(job_unload "$LABEL")" || why="Apple's Screen Sharing is still loaded, from $(loaded_from): $out"; fi
  out="$(switch_off)" || why="${why:+$why; }$out"
  [[ -z $why ]] || { echo "$why"; return 1; }
}

# This script's plist loaded, its label switched on only for each bootstrap:
# enable, bootstrap, disable, nothing in between (up to 5 tries, 1 s apart).
# When the switch won't go off afterwards, the job is unloaded again.
own_load() {
  local i out="" why unload
  for i in 1 2 3 4 5; do
    out="$(launchctl enable "system/$LABEL" 2>&1 && launchctl bootstrap system "$OWN_PLIST" 2>&1)" || true
    launchctl disable "system/$LABEL" >/dev/null 2>&1 || true
    ours_loaded && break
    [[ $i == 5 ]] || sleep 1
  done
  if ! why="$(switch_off)"; then
    if unload="$(job_unload "$LABEL")"; then unload="so it's unloaded again"; else unload="and unloading it failed too: $unload"; fi
    echo "Screen Sharing was loaded, but $why; $unload"
    return 1
  fi
  ours_loaded || { echo "launchctl bootstrap $OWN_PLIST failed 5 times: $(oneline "$out"); com.apple.screensharing is loaded from $(loaded_from)"; return 1; }
}

# Screen Sharing's job unloaded (whichever plist it came from) and its switch off,
# each tried whatever the other did.
own_unload() {
  local why="" out
  out="$(job_unload "$LABEL")" || why="$out"
  out="$(switch_off)" || why="${why:+$why; }$out"
  [[ -z $why ]] || { echo "$why"; return 1; }
}

# A holding job ($1 label, $2 plist, $3 port) loaded, and holding its port as
# port_problem wants (up to 5 s).
holder_on() {
  local why i
  loaded "$1" || why="$(job_load "$1" "$2")" || { echo "$1: $why"; return 1; }
  for i in 1 2 3 4 5 6 7 8 9 10; do
    why="$(port_problem "$3")" || return 0
    [[ $i == 10 ]] || sleep 0.5
  done
  echo "$1 is loaded, but $why"
  return 1
}

# The hold job unloaded and TCP 15900 free (up to 5 s).
hold_off() {
  local out i
  out="$(job_unload "$HOLD_LABEL")" || { echo "$out"; return 1; }
  for i in 1 2 3 4 5 6 7 8 9 10; do
    out="$(listeners_on "$BACKEND_PORT")" || { echo "lsof couldn't list who listens on TCP $BACKEND_PORT"; return 1; }
    [[ -n $out ]] || return 0
    [[ $i == 10 ]] || sleep 0.5
  done
  echo "the hold job is unloaded, but TCP $BACKEND_PORT is still open: $(listeners_text "$BACKEND_PORT")"
  return 1
}

# Screen Sharing on. From off: the forward parked (read back), the hold job aside,
# this script's plist loaded. Then its port verified, and only then the forward
# pointed at it.
backend_on() {
  local why i
  if ! ours_loaded; then
    why="$(serve_park)" || { echo "$why; Screen Sharing stays off until it can be"; return 1; }
    why="$(hold_off)" || { echo "$why"; return 1; }
    why="$(own_load)" || { echo "$why"; return 1; }
  fi
  for i in 1 2 3 4 5 6 7 8 9 10; do
    why="$(port_problem "$BACKEND_PORT" screensharing)" || break
    [[ $i == 10 ]] || sleep 0.5
  done
  [[ -z $why ]] || { echo "Screen Sharing is loaded, but $why"; return 1; }
  serve_live
}

# Screen Sharing off: the forward parked first (read back), then its job unloaded
# and the switch off, then the hold job on its port. A forward that can't be
# shown parked keeps Screen Sharing loaded, holding its port.
backend_off() {
  local why out
  if loaded "$LABEL"; then
    if ! why="$(serve_park)"; then
      out="$(switch_off)" || why="$why; $out"
      echo "$why; so Screen Sharing stays loaded, holding its port, until the forward can be moved"
      return 1
    fi
    why="$(own_unload)" || { echo "$why"; return 1; }
  else
    why="$(switch_off)" || { echo "$why"; return 1; }
  fi
  why="$(holder_on "$HOLD_LABEL" "$HOLD_PLIST" "$BACKEND_PORT")" && return 0
  # Someone else has the port: the tailnet mustn't reach them either.
  out="$(serve_park)" || why="$why; and Tailscale Serve's forward couldn't be moved off it: $out"
  echo "$why"
  return 1
}

# This script's plist made again from Apple's. When a macOS update changed
# Apple's, it's replaced, Screen Sharing (if on) turned off first so that the
# rest of the check loads the new one.
refresh_own_plist() {
  local tmp out
  install -d -o root -g wheel -m 755 "$OWN_DIR" || { echo "can't make $OWN_DIR"; return 1; }
  tmp="$(mktemp "$OWN_DIR/.blacksand-ss.XXXXXX")" || { echo "can't make a file in $OWN_DIR"; return 1; }
  if ! render_own_plist "$tmp"; then rm -f "$tmp"; echo "couldn't make Screen Sharing's plist from $APPLE_PLIST"; return 1; fi
  if cmp -s "$tmp" "$OWN_PLIST"; then rm -f "$tmp"; return 0; fi
  chmod 644 "$tmp"
  if ours_loaded; then
    out="$(backend_off)" || { rm -f "$tmp"; echo "$out"; return 1; }
    log "Screen Sharing's plist changed with Apple's; reloading it" >&2
  fi
  mv -f "$tmp" "$OWN_PLIST"
}

# ------------------------------------------------------------- the checks --

# The checks' lock: flock(2) on $LOCK through fd 9, taken with macOS's own perl.
# The file is root's, 600 (this script's umask), in a folder only root can
# write: nobody else can open it to hold the lock. The kernel releases it when
# its holders are gone, killed included, so there's no stale lock. Status 0
# taken, 75 busy (another check holds it), 1 it can't be taken.
lock_take() {
  { exec 9>>"$LOCK"; } 2>/dev/null || return 1
  /usr/bin/perl -MFcntl=:flock -MErrno -e 'open(my $f, ">&=", 9) or exit 1; flock($f, LOCK_EX | LOCK_NB) and exit 0; exit($!{EWOULDBLOCK} ? 75 : 1)' 2>/dev/null
}

# Runs "$@" in a process group of its own, stdin /dev/null, for at most $1
# seconds: then the whole group is killed (status 124). Only that group is ever
# signalled, never the caller's (an admin's terminal, say). WORKER names it
# while it runs, for on_signal.
bounded() {
  local secs="$1" status=0 timer i
  shift
  set -m
  ("$@") </dev/null &
  WORKER=$!
  (exec 9>&- </dev/null >/dev/null 2>&1; command sleep "$secs"; kill -KILL -- "-$WORKER") &
  timer=$!
  set +m
  # A signal before WORKER was set: kill it now; after, on_signal does.
  [[ -z $SIGNALLED ]] || kill -KILL -- "-$WORKER" 2>/dev/null || true
  wait "$WORKER" 2>/dev/null || status=$?
  # A signal interrupts that wait: wait for the killed worker itself.
  [[ -z $SIGNALLED ]] || wait "$WORKER" 2>/dev/null || true
  # Killing a group can miss a process it was starting at that moment (macOS,
  # under load), which then runs on: a killed worker's group is killed again
  # until nothing is left in it (for at most a second).
  if [[ -n $SIGNALLED ]] || ((status == 137)); then
    for ((i = 0; i < 100; i++)); do
      kill -KILL -- "-$WORKER" 2>/dev/null || break
      command sleep 0.01
    done
  fi
  WORKER=""
  kill -KILL -- "-$timer" 2>/dev/null || true
  wait "$timer" 2>/dev/null || true
  ((status != 137)) || status=124
  return "$status"
}

# TERM, INT, HUP (launchd stopping the check, ^C): the running worker killed;
# run_check then puts the switch back off and exits.
on_signal() {
  SIGNALLED="${SIGNALLED:-$1}"
  [[ -z $WORKER ]] || kill -KILL -- "-$WORKER" 2>/dev/null || true
}

# A failed check's reason, logged once (until it changes) and kept in $FAILING.
# $1 is 1 when Screen Sharing is off, 0 when it couldn't be turned off.
report_problem() {
  [[ "$(cat "$FAILING" 2>/dev/null)" != "$2" ]] || return 0
  if (($1)); then log "Screen Sharing is off: $2"; else log "Screen Sharing could NOT be turned off: $2"; fi
  printf '%s\n' "$2" >"$FAILING"
}

# Screen Sharing turned off outside a check's body (one ran past its deadline, or
# none could run), bounded, and what happened recorded.
stop_screen_sharing() {
  local status=0
  bounded "$STOP_DEADLINE" stop_body "$1" || status=$?
  ((status != 124)) || report_problem 0 "$1; turning it off didn't finish within ${STOP_DEADLINE}s"
}
stop_body() {
  local why
  if why="$(backend_off)"; then report_problem 1 "$1"; else report_problem 0 "$1; $why"; fi
}

# One check, the only way any runs: each minute's, and setup's, --on's, --off's
# and --uninstall's ($2, the body: check_body unless said). Under the lock (with
# "wait", up to 100 s for a running check), in a process group of its own, for
# at most CHECK_DEADLINE seconds. One killed at its deadline, or unable to take
# the lock, turns Screen Sharing off; after a kill or a signal the switch is put
# back off first. Status 0 passed, 1 failed, 2 skipped (another check running).
run_check() {
  local mode="$1" body="${2:-check_body}" taken=0 status=0 i signalled
  SIGNALLED="" WORKER=""
  trap 'on_signal 143' TERM
  trap 'on_signal 130' INT
  trap 'on_signal 129' HUP
  for ((i = 0; ; i++)); do
    taken=0
    lock_take || taken=$?
    [[ $taken == 75 && $mode == wait && $i -lt 200 && -z $SIGNALLED ]] || break
    sleep 0.5
  done
  case "$taken" in
    0) bounded "$CHECK_DEADLINE" "$body" || status=$? ;;
    75) if [[ $mode == wait && -z $SIGNALLED ]]; then printf '%s\n' "another check held the lock for over 100 s" >"$FAILING"; status=1; else status=2; fi ;;
    *) status=3 ;;
  esac
  signalled="$SIGNALLED"
  SIGNALLED=""
  if [[ -n $signalled ]] || ((status == 124 || status == 3)); then
    trap '' TERM INT HUP
    bounded 10 switch_off || log "Screen Sharing's switch couldn't be put back off"
    if [[ -z $signalled ]]; then
      ((status != 124)) || stop_screen_sharing "a check ran past ${CHECK_DEADLINE}s and was stopped"
      ((status != 3)) || stop_screen_sharing "the checks' lock couldn't be taken ($LOCK)"
    fi
  fi
  exec 9>&-
  [[ -z $signalled ]] || exit "$signalled"
  trap - TERM INT HUP
  ((status == 0 || status == 2)) || status=1
  return "$status"
}

# Apple's version and the switch off, the parking job on its port; then Screen
# Sharing on if it's wanted and every rule holds, else off. What this Mac alone
# can tell comes first: nothing before the TCP 5900 rule waits on tailscaled.
check_body() {
  local problem="" why closed=1
  why="$(apple_off)" || problem="$why"
  if ! why="$(holder_on "$PARK_LABEL" "$PARK_PLIST" "$PARK_PORT")"; then problem="${problem:+$problem; }$why"; fi
  if [[ -f $WANTED ]]; then
    if why="$(policy_problem)"; then problem="${problem:+$problem; }$why"; fi
    if why="$(forwarding_problem)"; then problem="${problem:+$problem; }$why"; fi
    if [[ -z $problem ]] && why="$(foreign_5900)"; then problem="$why"; fi
    if [[ -z $problem ]] && { ! why="$(refresh_own_plist)" || ! why="$(backend_on)"; }; then problem="$why"; fi
  fi
  if [[ -n $problem || ! -f $WANTED ]] && ! why="$(backend_off)"; then
    closed=0
    problem="${problem:+$problem; }$why"
  fi
  if [[ -n $problem ]]; then
    report_problem "$closed" "$problem"
    return 1
  fi
  if [[ -f $FAILING ]]; then
    rm -f "$FAILING"
    log "checks pass again; Screen Sharing is $([[ -f $WANTED ]] && echo on || echo "off, as asked")"
  fi
}

# ------------------------------------------------------------------ setup --

install_check() {
  local here dir out
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  for dir in "${HELPER_DIR%/*/*}" "${HELPER_DIR%/*}" "$HELPER_DIR"; do
    [[ -d $dir ]] || install -d -o root -g wheel -m 755 "$dir"
  done
  install -o root -g wheel -m 755 "$here/enable-screen-sharing.sh" "$CHECK"
  install -o root -g wheel -m 644 "$here/host-common.sh" "$HELPER_DIR/host-common.sh"
  write_plist "$CHECK_PLIST" render_check_plist
  out="$(job_unload "$CHECK_LABEL")" || die "$out"
  out="$(job_load "$CHECK_LABEL" "$CHECK_PLIST")" || die "$out"
}

# The hold and parking jobs: their plists in LaunchDaemons (both hold their ports
# from boot on), the parking job loaded, and the hold job too unless Screen
# Sharing is on. A loaded one isn't reloaded: its port would be free in between.
install_holds() {
  local out
  write_plist "$HOLD_PLIST" render_hold_plist "$HOLD_LABEL" "$BACKEND_PORT"
  write_plist "$PARK_PLIST" render_hold_plist "$PARK_LABEL" "$PARK_PORT"
  out="$(holder_on "$PARK_LABEL" "$PARK_PLIST" "$PARK_PORT")" || die "$out"
  ours_loaded || { out="$(holder_on "$HOLD_LABEL" "$HOLD_PLIST" "$BACKEND_PORT")" || die "$out"; }
}

# Exactly the admin account in Screen Sharing's list, by name and GUID (no nested
# groups, no "All users" leftover), and its identity recorded for the check.
reconcile_access() {
  local member guid
  guid="$(guid_of "$SS_USER")"
  [[ -n $guid ]] || die "no GeneratedUID for $SS_USER"
  printf '%s %s %s\n' "$SS_USER" "$(id -u "$SS_USER")" "$guid" >"$USER_FILE"
  if dscl . -read "/Groups/$ACCESS_GROUP-disabled" >/dev/null 2>&1; then dseditgroup -o delete "$ACCESS_GROUP-disabled"; fi
  dscl . -read "/Groups/$ACCESS_GROUP" >/dev/null 2>&1 || dseditgroup -o create -q "$ACCESS_GROUP"
  dseditgroup -o edit -a "$SS_USER" -t user "$ACCESS_GROUP"
  for member in $(group_values "$ACCESS_GROUP" GroupMembership); do
    [[ $member == "$SS_USER" ]] || dseditgroup -o edit -d "$member" -t user "$ACCESS_GROUP"
  done
  for member in $(group_values "$ACCESS_GROUP" GroupMembers); do
    [[ $member == "$guid" ]] || dscl . -delete "/Groups/$ACCESS_GROUP" GroupMembers "$member"
  done
  for member in $(group_values "$ACCESS_GROUP" NestedGroups); do
    dscl . -delete "/Groups/$ACCESS_GROUP" NestedGroups "$member"
  done
  dsmemberutil flushcache
  say "Screen Sharing sign-in allowed for: $(group_values "$ACCESS_GROUP" GroupMembership | xargs)"
}

# No shared VNC password, no "anyone may request permission to control".
vnc_password_off() {
  rm -f "$VNC_PASSWORD_FILE"
  defaults write "$RM_PREFS" VNCLegacyConnectionsEnabled -bool NO
  defaults write "$RM_PREFS" ScreenSharingReqPermEnabled -bool NO
}

# Before anything changes. --no-serve never on a Serve setup (--uninstall
# first: its saved forward has to go). With Serve: TCP 5900 free or this
# script's forward, and nothing else in Serve mentioning 15900 or 15901; without
# tailscaled running, a warning (the check sets the forward once it is).
serve_preflight() {
  if ((NO_SERVE)); then
    [[ ! -e $SERVE ]] || die "this is set up with Tailscale Serve; to switch to --no-serve, run --uninstall first. Nothing was changed."
    return 0
  fi
  if ! tailscaled_up; then
    warn "tailscaled isn't running here; once it is, the check forwards the tailnet's TCP $PORT to Screen Sharing ($LIVE)"
    return 0
  fi
  serve_read || die "couldn't read Tailscale Serve's configuration ($SV_WHY). Nothing was changed."
  [[ $SV_MAIN == none || $SV_MAIN == "tcp $LIVE" || $SV_MAIN == "tcp $PARKED" ]] ||
    die "Tailscale Serve's TCP $PORT is in use ($SV_MAIN); remove that mapping (tailscale serve status), then rerun. Nothing was changed."
  [[ -z $SV_OTHERS ]] ||
    die "Tailscale Serve already mentions TCP $BACKEND_PORT or $PARK_PORT ($SV_OTHERS); remove that (tailscale serve status), then rerun. Nothing was changed."
}

install_all() {
  local i capture out over=loopback
  SETUP_DONE=0
  [[ -n ${SUDO_USER:-} && $SUDO_USER != root ]] || die "run with sudo from your admin account, not as root"
  SS_USER="$SUDO_USER"
  dseditgroup -o checkmember -m "$SS_USER" admin >/dev/null 2>&1 || die "$SS_USER isn't an admin; run this from the admin account that should sign in"
  ! is_agent "$SS_USER" || die "$SS_USER is an agent account"
  [[ -f $APPLE_PLIST ]] || die "$APPLE_PLIST is missing: this macOS has no Screen Sharing to run"
  ! remote_management_on || die "Remote Management is on; it replaces Screen Sharing and has its own access settings. Turn it off (System Settings → General → Sharing → Remote Management, or: sudo $ARD_KICKSTART -deactivate -stop), then rerun."
  if out="$(forwarding_problem)"; then die "$out. Turn off what turned it on (System Settings → General → Sharing → Internet Sharing, or VM software), then rerun. Nothing was changed."; fi
  serve_preflight
  say "Switching Apple's every-interface Screen Sharing off for good"
  out="$(apple_off)" || die "$out"
  reconcile_access
  vnc_password_off
  say "Screen Sharing on localhost:$BACKEND_PORT only (127.0.0.1 and ::1), from $OWN_PLIST, loaded only by the check"
  out="$(refresh_own_plist)" || die "$out"
  say "Root launchd jobs holding TCP $BACKEND_PORT while Screen Sharing is off, and $PARK_PORT for Tailscale Serve's parked forward"
  install_holds
  rm -f "$FAILING"
  ((NO_SERVE)) || [[ -e $SERVE ]] || : >"$SERVE"
  : >"$WANTED"
  install_check
  # From here on a failed setup turns Screen Sharing off again.
  trap setup_failed EXIT
  run_check wait || die "the check failed: $(cat "$FAILING" 2>/dev/null || echo "see $CHECK_LOG"); sudo $0 --status"
  ours_loaded || die "Screen Sharing isn't on after the check; sudo $0 --status"
  for i in 1 2 3; do
    rfb_answers && break
    [[ $i != 3 ]] || die "screensharingd didn't answer on $LIVE (no RFB greeting). Look for a crash report, /Library/Logs/DiagnosticReports/screensharingd-*.ips (a crash in _xpc_api_misuse means its socket wasn't dual-stack), and launchd's 'checkin: socket count' line: log show --last 5m --predicate 'process == \"launchd\"' | grep -i screensharing"
    sleep 2
  done
  # A greeting isn't a working Screen Sharing: what macOS lets screensharingd do,
  # from its check-in for that connection.
  for i in 1 2 3; do
    capture="$(capture_state 2m)"
    [[ $capture == unknown* && $i != 3 ]] || break
    sleep 2
  done
  case "$capture" in
    granted*) say "Screen capture and control: $capture" ;;
    denied*) die "$CAPTURE_REMEDY [screensharingd: ${capture#denied }]" ;;
    *) warn "couldn't confirm that macOS lets Screen Sharing capture the screen and take input ($capture); check a session from the desktop Mac shows the screen, not black" ;;
  esac
  if ((!NO_SERVE)); then
    over=pending
    if serve_read && [[ $SV_STATE == read && $SV_MAIN == "tcp $LIVE" ]]; then over=live; fi
  fi
  SETUP_DONE=1
  trap - EXIT
  case "$over" in
    live) printf '\nDone. Screen Sharing is on for %s, on this Mac'"'"'s loopback and over Tailscale.\n' "$SS_USER" ;;
    pending) printf '\nDone, for loopback: Screen Sharing is on for %s on this Mac'"'"'s loopback. Over Tailscale\nit'"'"'s pending: the check forwards the tailnet'"'"'s TCP %s once tailscaled is up and nothing\nelse is in the way (--status then shows "Serve forward: TCP %s → %s").\n' "$SS_USER" "$PORT" "$PORT" "$LIVE" ;;
    loopback) printf '\nDone. Screen Sharing is on for %s, on this Mac'"'"'s loopback only (--no-serve).\n' "$SS_USER" ;;
  esac
  if [[ $over == loopback ]]; then
    cat <<EOF
  1. On the desktop Mac: ssh -N -L 15900:127.0.0.1:15900 <this Mac>, then Finder → Go →
     Connect to Server → vnc://127.0.0.1:15900, signed in as $SS_USER (Standard mode).
EOF
  else
    cat <<EOF
  1. Tailscale policy (admin console → Access controls): merge in
       scripts/enable-screen-sharing.sh --print-policy
  2. $([[ $over == live ]] && echo "On the desktop Mac" || echo "Once the forward is there, on the desktop Mac"): Finder → Go → Connect to Server →
     vnc://<this Mac's tailnet name>, signed in as $SS_USER (Standard mode).
EOF
  fi
  cat <<EOF
  The screen must show, not black. From another Mac on your local network, port 5900
  must be refused: nc -z -G 3 <this Mac's LAN address> 5900
  System Settings shows Screen Sharing as off: that's Apple's switch, which stays off.
  Status any time: sudo $0 --status
EOF
}

# Why Screen Sharing isn't verifiably off, or nothing (status 1): its label not
# loaded, its switch off, and TCP 15900 the hold job's: root's launchd on
# 127.0.0.1 and ::1, nothing else.
off_problem() {
  local why="" out
  ! loaded "$LABEL" || why="$LABEL is still loaded, from $(loaded_from)"
  switched_off "$LABEL" || why="${why:+$why; }its switch is on"
  if out="$(port_problem "$BACKEND_PORT")"; then why="${why:+$why; }$out"; fi
  [[ -n $why ]] || return 1
  echo "$why"
}

# "; the last check: …" when the last failed check said something else than $1.
last_check() { local last; last="$(cat "$FAILING" 2>/dev/null || true)"; [[ -z $last || $last == "$1" ]] || echo "; the last check: $last"; }

# Setup's exit trap, once Screen Sharing may have started: any exit before the
# end is a failure (bash may hand an EXIT trap status 0, after an unset variable
# say). Screen Sharing is no longer wanted, a check turns it off, and what's true
# is said: off only when that's verified.
setup_failed() {
  local status=$? off
  ((SETUP_DONE)) && return 0
  rm -f "$WANTED"
  run_check wait >/dev/null 2>&1 || true
  if off="$(off_problem)"; then
    warn "setup failed, and Screen Sharing could NOT be turned off: $off$(last_check "$off")"
  else
    warn "setup failed, so Screen Sharing is off again; fix what's above and rerun"
  fi
  exit $((status == 0 ? 1 : status))
}

turn_off() {
  local problem
  rm -f "$WANTED"
  run_check wait || true
  if problem="$(off_problem)"; then die "Screen Sharing isn't verifiably off: $problem$(last_check "$problem")"; fi
  say "Screen Sharing is off (rerun this script, or --on, to turn it on)"
}

# Uninstall's first step, a check's body (under the lock): Screen Sharing no
# longer wanted, and this setup's TCP 5900 forward removed, with nothing else
# mentioning 15900 or 15901, read back; only then is Serve no longer this
# setup's. Every holder keeps its port meanwhile. Status 1, with the reason in
# $FAILING, when that can't be.
uninstall_serve() {
  local why=""
  rm -f "$WANTED"
  [[ -s $SERVE ]] || { rm -f "$SERVE"; return 0; }
  if ! serve_read; then
    why="Tailscale Serve's configuration can't be read ($SV_WHY)"
  elif [[ $SV_STATE != read ]]; then
    why="tailscaled isn't running, so Tailscale Serve's forward can't be removed: start it"
  elif [[ -n $SV_OTHERS ]]; then
    why="Tailscale Serve still mentions TCP $BACKEND_PORT or $PARK_PORT ($SV_OTHERS): remove that (tailscale serve status)"
  elif [[ $SV_MAIN == "tcp $LIVE" || $SV_MAIN == "tcp $PARKED" ]]; then
    why="$(serve_tcp_set "$PORT" "${SV_MAIN#tcp }" none "$BACKEND_PORT,$PARK_PORT")" || true
  elif [[ $SV_MAIN == *"$BACKEND_PORT"* || $SV_MAIN == *"$PARK_PORT"* ]]; then
    why="Tailscale Serve's TCP $PORT is $SV_MAIN: remove it (tailscale serve status)"
  fi
  [[ -z $why ]] || { printf '%s\n' "uninstall stopped: $why" >"$FAILING"; return 1; }
  rm -f "$SERVE"
  say "Tailscale Serve: nothing forwards to TCP $BACKEND_PORT or $PARK_PORT"
}

# Everything this script added removed, in an order that never frees a port
# Serve may still reach: first the forward (uninstall_serve), then the check job,
# Screen Sharing, Apple's version and the switch, the hold and parking jobs, then
# the files. Each step works from whatever an earlier uninstall left, so a rerun
# finishes one that stopped.
uninstall_all() {
  local out label problem=""
  say "Turning Screen Sharing off and removing what this script added"
  run_check wait uninstall_serve ||
    die "$(cat "$FAILING" 2>/dev/null || echo "uninstall stopped"); nothing else was removed, and the check turns Screen Sharing off (no longer wanted). Rerun --uninstall once that's fixed."
  out="$(job_unload "$CHECK_LABEL")" || die "uninstall stopped: $out; rerun --uninstall"
  for label in "$LABEL" "$HOLD_LABEL" "$PARK_LABEL"; do
    out="$(job_unload "$label")" || problem="${problem:+$problem; }$out"
  done
  out="$(switch_off)" || problem="${problem:+$problem; }$out"
  [[ -z $problem ]] || die "uninstall stopped: $problem; rerun --uninstall"
  rm -f "$CHECK_PLIST" "$HOLD_PLIST" "$PARK_PLIST" "$OWN_PLIST" "$USER_FILE" "$WANTED" "$SERVE" \
    "$CHECK" "$HELPER_DIR/host-common.sh" "$FAILING" "$LOCK"
  rmdir "$OWN_DIR" 2>/dev/null || true
  say "Done. Screen Sharing's switch stays off; turning it on in System Settings starts Apple's version, open to your local network. Remove the TCP 5900 grant from the tailnet policy too."
}

# ----------------------------------------------------------------- status --

# Serve's TCP 5900 forward, in words: only what tailscaled shows.
serve_forward_text() {
  local text
  [[ -f $SERVE ]] || { echo "not used (--no-serve)"; return 0; }
  serve_read || { echo "can't read it ($SV_WHY)"; return 0; }
  if [[ $SV_STATE != read ]]; then
    [[ -s $SERVE ]] || { echo "none yet (tailscaled isn't running)"; return 0; }
    echo "unknown: tailscaled isn't running (it restores its saved forward when it starts)"
    return 0
  fi
  case "$SV_MAIN" in
    "tcp $LIVE") text="TCP $PORT → $LIVE (Screen Sharing's port)" ;;
    "tcp $PARKED") text="TCP $PORT → $PARKED (parked; new Serve connections don't reach Screen Sharing)" ;;
    none) text="none on TCP $PORT" ;;
    *) text="TCP $PORT is $SV_MAIN" ;;
  esac
  echo "$text${SV_OTHERS:+; also mentioning TCP $BACKEND_PORT or $PARK_PORT: $SV_OTHERS}"
}

row() { printf '%-21s%s\n' "$1:" "$2"; }

status() {
  local problem check
  if ours_loaded; then row "Screen Sharing" "on (from $OWN_PLIST)"
  elif loaded "$LABEL"; then row "Screen Sharing" "APPLE'S EVERY-INTERFACE VERSION, from $(loaded_from)"
  else row "Screen Sharing" "off (its job isn't loaded)"
  fi
  row "answers on loopback" "$(rfb_answers && echo "yes (RFB; who holds the port: below)" || echo no)"
  row "screen capture" "$(capture_state 30m)"
  row "TCP $BACKEND_PORT" "$(listeners_text "$BACKEND_PORT")"
  if problem="$(port_problem "$BACKEND_PORT" "$(ours_loaded && echo screensharing)")"; then row problem "$problem"; fi
  row "hold job" "$(loaded "$HOLD_LABEL" && echo "loaded (holds TCP $BACKEND_PORT while Screen Sharing is off)" || echo "not loaded")"
  row "parking job" "$(loaded "$PARK_LABEL" && echo "loaded, TCP $PARK_PORT: $(listeners_text "$PARK_PORT")" || echo "not loaded")"
  if problem="$(port_problem "$PARK_PORT")"; then row problem "$problem"; fi
  row "TCP $PORT (Serve)" "$(listeners_text "$PORT")"
  row "Serve forward" "$(serve_forward_text)"
  row "its switch" "$(switched_off "$LABEL" && echo "off (as it should be, loaded or not)" || echo "ON: a restart would start Apple's every-interface version")"
  row "wanted" "$([[ -f $WANTED ]] && echo yes || echo no)"
  row "check job" "$(loaded "$CHECK_LABEL" && echo loaded || echo "not loaded")"
  row "sign-in allowed" "$(group_values "$ACCESS_GROUP" GroupMembership | xargs)"
  for check in policy_problem forwarding_problem foreign_5900; do
    if problem="$($check)"; then row problem "$problem"; fi
  done
  [[ ! -f $FAILING ]] || row "last failed check" "$(cat "$FAILING")"
}

main() {
  local mode=install status=0
  NO_SERVE=0
  while (($#)); do
    case "$1" in
      check) mode=check; shift ;;
      --on) mode=on; shift ;;
      --off) mode=off; shift ;;
      --status) mode=status; shift ;;
      --uninstall) mode=uninstall; shift ;;
      --no-serve) NO_SERVE=1; shift ;;
      --print-policy) mode=policy; shift ;;
      --host-tag) HOST_TAG="${2:-}"; shift 2 ;;
      --desktop-tag) DESKTOP_TAG="${2:-}"; shift 2 ;;
      --phone-tag) PHONE_TAG="${2:-}"; shift 2 ;;
      *) die "unknown option $1" ;;
    esac
  done
  check_tags "$HOST_TAG" "$DESKTOP_TAG" "$PHONE_TAG"
  if [[ $mode == policy ]]; then
    print_policy
    return 0
  fi
  # The installed check runs only where this installed it; --status only looks.
  [[ $mode == check || $mode == status ]] || refuse_legacy_install
  [[ "$(uname -s)" == Darwin ]] || die "macOS only"
  [[ $EUID -eq 0 ]] || die "run with sudo: sudo $0 $*"
  case "$mode" in
    check)
      run_check periodic || status=$?
      ((status != 1)) || exit 1
      ;;
    on)
      [[ -f $USER_FILE ]] || die "not set up yet: run sudo $0"
      : >"$WANTED"
      run_check wait || die "the check failed: $(cat "$FAILING" 2>/dev/null); see sudo $0 --status"
      ;;
    off) turn_off ;;
    status) status ;;
    uninstall) uninstall_all ;;
    install) install_all ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
