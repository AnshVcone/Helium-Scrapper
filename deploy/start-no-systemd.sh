#!/usr/bin/env bash
# Start/stop the scraper on a box where a systemd unit cannot be installed.
#
# deploy/h10-scraper.service is the better answer, but it needs root and `sudo`
# wants a password on a shared VM. This is the fallback.
#
# Three things it gets right that the obvious `nohup node src/server.js &` does
# not, all learned the hard way on 103.127.29.157:
#
#  1. setsid. Ubuntu 22.04 ships KillUserProcesses=yes and, without lingering
#     (root-only), systemd-logind kills every process in the user session the
#     moment the last SSH connection closes. nohup only ignores SIGHUP.
#
#  2. A PID FILE, not pgrep. `cd $APP && node src/server.js` leaves the cmdline
#     as the RELATIVE path, so patterns built from $APP match nothing. That cost
#     an hour: the "is it running" check reported stopped while the server was
#     serving happily, so each restart started a second one that died on
#     EADDRINUSE, and the orphan cleanup silently cleaned nothing.
#
#  3. Chromium cleanup. Chromium outlives a SIGKILLed parent -- the runner's
#     finally block never runs -- and keeps ~800 MB. On a 3.8 GB box with no
#     swap that is the difference between working and an OOM kill. 14 orphans
#     were found this way.
#
#   bash deploy/start-no-systemd.sh           start or restart
#   bash deploy/start-no-systemd.sh --stop    stop, and clean up Chromium
#   bash deploy/start-no-systemd.sh --status  report without changing anything
set -uo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="${SCRAPER_LOG:-$APP/../logs/scraper.log}"
PIDFILE="$APP/../scraper.pid"

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null
fi

running_pid() {
  local pid
  # Preferred: the pid file we wrote.
  if [ -f "$PIDFILE" ]; then
    pid="$(cat "$PIDFILE" 2>/dev/null)"
    if [ -n "$pid" ] && grep -qs "server.js" "/proc/$pid/cmdline" 2>/dev/null; then
      echo "$pid"; return 0
    fi
  fi
  # Fallback: a server started before this script existed, or by hand, has no
  # pid file. Identify it by cmdline AND working directory -- the cmdline alone
  # is the relative "node src/server.js", which would also match another copy of
  # this repo elsewhere on a shared box.
  for pid in $(pgrep -f "server\.js" 2>/dev/null); do
    if [ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" = "$APP" ]; then
      echo "$pid"; return 0
    fi
  done
  return 1
}

kill_chromium() {
  # Anchored on the profile path, which DOES appear in Chromium's cmdline
  # (--user-data-dir=...), so unlike the server this pattern is reliable.
  pkill -f "user-data-dir=$APP/profile" 2>/dev/null
  sleep 2
  pkill -9 -f "user-data-dir=$APP/profile" 2>/dev/null
  pkill -f chrome_crashpad_handler 2>/dev/null
  return 0
}

case "${1:-start}" in
  --status)
    if pid="$(running_pid)"; then echo "server: running (pid $pid)"; else echo "server: not running"; fi
    echo "chrome processes: $(pgrep -c chrome 2>/dev/null || echo 0)"
    free -m 2>/dev/null | awk '/^Mem:/{print "memory: "$3"MB used, "$7"MB available"}'
    exit 0
    ;;
  --stop)
    if pid="$(running_pid)"; then kill "$pid" 2>/dev/null; sleep 3; kill -9 "$pid" 2>/dev/null; fi
    rm -f "$PIDFILE"
    kill_chromium
    echo "stopped; chrome processes remaining: $(pgrep -c chrome 2>/dev/null || echo 0)"
    exit 0
    ;;
esac

if pid="$(running_pid)"; then
  echo "already running (pid $pid) — stopping it first"
  kill "$pid" 2>/dev/null; sleep 3; kill -9 "$pid" 2>/dev/null
fi
rm -f "$PIDFILE"
kill_chromium

mkdir -p "$(dirname "$LOG")"
cd "$APP" || exit 1
setsid nohup node src/server.js >> "$LOG" 2>&1 < /dev/null &
echo $! > "$PIDFILE"
sleep 5

if pid="$(running_pid)"; then
  echo "started, pid $pid"
  echo "log: $LOG"
  grep -E "listening on|MODE=|alerts ->" "$LOG" | tail -3
else
  echo "FAILED to start. Last log lines:"; tail -8 "$LOG"; rm -f "$PIDFILE"; exit 1
fi
