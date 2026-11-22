#!/bin/sh
# AIPayGen AI crawler report for nginx. Run every 10 minutes from root's crontab:
#   */10 * * * * /usr/local/bin/aipaygen-report.sh
# It sends the AI crawler visits nginx logged to your report, and keeps the AI crawler address list
# (and, once you charge, your price) fresh. A new file is checked before it replaces the old one, and
# nginx is reloaded only when something changed and nginx -t passes; otherwise the last good file is
# put back. If AIPayGen can't be reached it keeps what it has and tries again next run.
set -u
ROUTE="YOUR_ROUTE_ID"
SECRET="YOUR_GATEWAY_SECRET"          # the gateway secret you got at sign-up (keep this file chmod 700)
[ -r /etc/aipaygen/secret ] && SECRET="$(head -n 1 /etc/aipaygen/secret)"   # set by the one-line installer (root only, mode 600)
API="https://aipaygen.com"
LOG="/var/log/nginx/aipaygen-ai.log"
NGINX_DIR="/etc/nginx"
PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin"   # cron's PATH often lacks nginx's folder
umask 022
rc=0
# Keep a log under 1 MB (its newest lines), so it can't fill the disk while counts can't be sent.
cap() {
  if [ -f "$1" ] && [ "$(wc -c < "$1" | tr -d ' ')" -gt 1048576 ]; then
    tail -c 1048576 "$1" | tail -n +2 > "$1.cap" && cat "$1.cap" > "$1"
    rm -f "$1.cap"
  fi
}
# POST the counts. The secret reaches curl on stdin, never on its command line (where ps shows it).
# Returns 0 when sent, 2 when AIPayGen refused them for good (wrong route or secret), 1 to retry later.
send() {
  code=$(printf 'header = "x-aipaygen-gateway-secret: %s"\n' "$SECRET" | curl -sS -m 20 -K - -o /dev/null -w '%{http_code}' -X POST "$1" -H "content-type: application/json" --data-binary "$2" 2>/dev/null) || true
  case "$code" in
    2??) return 0 ;;
    429) return 1 ;;
    4??) echo "aipaygen: AIPayGen refused the visit counts (HTTP $code). Check ROUTE and SECRET in this script; these counts were dropped." >&2; return 2 ;;
    *) return 1 ;;
  esac
}

# 1. Visit counts. nginx appends to the log, so emptying it in place is safe.
TMP="$LOG.sending"
cap "$LOG"
if [ -s "$LOG" ] && [ "$SECRET" != "YOUR_GATEWAY_SECRET" ]; then
  cp "$LOG" "$TMP" && : > "$LOG"
  BODY=$(awk -F '\t' '
  $1 != "" { n[$1]++; if ($2 ~ /^\// && length($2) <= 200) p[$2]++ }
  END {
    printf "{\"counts\":{"; s = ""
    for (b in n) { printf "%s\"%s\":%d", s, b, n[b]; s = "," }
    printf "},\"paths\":{"; s = ""
    for (i = 0; i < 10; i++) {
      best = ""; bn = 0
      for (q in p) if (p[q] > bn) { best = q; bn = p[q] }
      if (best == "") break
      printf "%s\"%s\":%d", s, best, bn; s = ","; delete p[best]
    }
    printf "}}"
  }' "$TMP")
  send "$API/v1/gateway/hits/$ROUTE" "$BODY"
  case $? in
    0) rm -f "$TMP"; touch "$LOG.reported" ;;
    2) rm -f "$TMP"; touch "$LOG.reported"; rc=1 ;;                          # refused for good: sending them again would fail again
    *) cat "$TMP" >> "$LOG"; rm -f "$TMP"; rc=1 ;;   # keep the visits for the next run
  esac
fi

# Installed but quiet: one empty report a day (none while counts went out), so your report shows the setup is live
# before any AI crawler comes. No visitor data in it: counts {}.
if [ "$SECRET" != "YOUR_GATEWAY_SECRET" ] && { [ ! -e "$LOG.reported" ] || [ -n "$(find "$LOG.reported" -mmin +1440 2>/dev/null)" ]; }; then
  send "$API/v1/gateway/hits/$ROUTE" '{"counts":{},"paths":{}}'
  case $? in
    0) touch "$LOG.reported" ;;
    2) touch "$LOG.reported"; rc=1 ;;   # refused for good (wrong secret, route gone): asking again would be refused again
    *) rc=1 ;;               # busy or unreachable: try again next run
  esac
fi

# True when the file is missing or older than this many minutes.
stale() { [ ! -s "$1" ] || [ -n "$(find "$1" -mmin +"$2" 2>/dev/null)" ]; }
# A download has the expected shape: its first line starts with $2, every other line is a comment,
# blank, or matches the regex $3, and at least $4 lines match. An error page or a cut-off file fails.
looks_ok() {
  awk -v head="$2" -v line="$3" -v min="$4" '
    NR == 1 { if (index($0, head) != 1) bad = 1; next }
    $0 ~ line { n++; next }
    /^#/ || /^$/ { next }
    { bad = 1 }
    END { exit !(n >= min + 0 && !bad) }' "$1"
}
# The AI crawler names file: exactly our header and the two map lines we generate, with only crawler names inside
# their two groups (letters, digits, "\-" and "|"). Anything else (another directive, an include, a "$" or a "}"
# anywhere else, an extra line) is refused, and the last good file stays. So is a name that would match people's
# browsers (under 4 characters, a browser token, or found in a browser's user agent), or a list under half the size of
# the one in place ($2).
bots_ok() {
  P1='map $http_user_agent $aipaygen_ua_bot { default ""; "~*(' S1=')" $1; }' \
  P2='map "$aipaygen_ua_bot|$aipaygen_ai_ip" $aipaygen_seen { default ""; "~^\|1$" "AI crawler (by IP)"; "~*^(' \
  S2=')\|0$" "$1 (fake)"; "~^([^|]+)\|" $1; }' awk -v cur="${2:-}" '
    BEGIN { split("mozilla chrome chromium safari applewebkit webkit gecko firefox edg edge opr opera mobile windows macintosh linux android iphone ipad khtml version like compatible", dl, " "); for (j in dl) deny[dl[j]] = 1
      ua[1] = "mozilla/5.0 (windows nt 10.0; win64; x64) applewebkit/537.36 (khtml, like gecko) chrome/131.0.0.0 safari/537.36 edg/131.0.0.0"
      ua[2] = "mozilla/5.0 (macintosh; intel mac os x 10_15_7) applewebkit/605.1.15 (khtml, like gecko) version/18.1 safari/605.1.15"
      ua[3] = "mozilla/5.0 (iphone; cpu iphone os 18_1 like mac os x) applewebkit/605.1.15 (khtml, like gecko) crios/131.0.6778.73 mobile/15e148 safari/604.1"
      ua[4] = "mozilla/5.0 (x11; linux x86_64; rv:133.0) gecko/20100101 firefox/133.0"
      ua[5] = "mozilla/5.0 (linux; android 14; sm-s918b) applewebkit/537.36 (khtml, like gecko) samsungbrowser/27.0 chrome/125.0.0.0 mobile safari/537.36"
      ua[6] = "mozilla/5.0 (windows nt 10.0; win64; x64) applewebkit/537.36 (khtml, like gecko) chrome/131.0.0.0 safari/537.36 opr/115.0.0.0" }
    function ok_name(u, l, j) { l = tolower(u); if (length(u) < 4 || (l in deny)) return 0; for (j in ua) if (index(ua[j], l)) return 0; return 1 }
    function names(x, k, a, j, u) { if (x == "" || x !~ /^[-A-Za-z0-9|\\]+$/ || x ~ /\\[^-]/ || x ~ /\\$/ || x ~ /^[|]|[|]$|[|][|]/) return 0
      k = split(x, a, "|"); for (j = 1; j <= k; j++) { u = a[j]; gsub(/\\-/, "-", u); if (!ok_name(u)) return 0 }; return k }
    function count(f, p, q, line, c, r) { if (f == "") return 0; while ((getline line < f) > 0) if (++c == 2) { r = names(mid(line, p, q)); break }; close(f); return r }
    function mid(x, p, q) { if (index(x, p) != 1 || length(x) <= length(p) + length(q) || substr(x, length(x) - length(q) + 1) != q) return ""; return substr(x, length(p) + 1, length(x) - length(p) - length(q)) }
    NR == 1 { ok = ($0 == "# AIPayGen AI crawler names v1"); next }
    NR == 2 { n2 = names(mid($0, ENVIRON["P1"], ENVIRON["S1"])); ok = ok && n2; next }
    NR == 3 { ok = ok && names(mid($0, ENVIRON["P2"], ENVIRON["S2"])); next }
    { ok = 0 }
    END { exit !(ok && NR == 3 && !(n2 * 2 < count(cur, ENVIRON["P1"], ENVIRON["S1"]))) }' "$1"
}

plain_get() { curl -fsS -m 30 "$1" -o "$2" 2>/dev/null; }
strict_get() { curl -fsS --proto =https --max-filesize 65536 --max-time 20 "$1" -o "$2" 2>/dev/null; }
# get URL FILE HEAD LINE MIN [CHECK [FETCH]]: download to FILE.new (plain_get, or FETCH), check it (looks_ok, or CHECK),
# and move it into place only if it changed.
changed=""
get() {
  if "${7:-plain_get}" "$1" "$2.new" && "${6:-looks_ok}" "$2.new" "$3" "$4" "$5"; then
    if cmp -s "$2.new" "$2"; then rm -f "$2.new"; touch "$2"; return 0; fi
    if [ -f "$2" ]; then cp -p "$2" "$2.old" || { rm -f "$2.new"; return 1; }; fi
    mv "$2.new" "$2" && changed="$changed $2"
  else
    rm -f "$2.new"; return 1
  fi
}

# 2. AI crawler addresses, once a day (the first run creates the file).
IPS="$NGINX_DIR/aipaygen-ai-ips.conf"
if [ -d "$NGINX_DIR" ] && stale "$IPS" 1440; then
  get "$API/v1/ai_bot_ips?format=nginx" "$IPS" "# AI crawler IP ranges" '^[0-9A-Fa-f.:]+([/][0-9]+)? 1;$' 1 || rc=1
fi
# 2b. The AI crawler names, once a day, and at once while the file is missing or still the installer's placeholder.
BOTS="$NGINX_DIR/aipaygen-bots.conf"
if [ -d "$NGINX_DIR" ] && { stale "$BOTS" 1440 || [ "$(head -n 1 "$BOTS" 2>/dev/null)" != "# AIPayGen AI crawler names v1" ]; }; then
  get "$API/v1/gateway/bots?format=nginx" "$BOTS" "$BOTS" "" 0 bots_ok strict_get || rc=1
fi
# 3. Your price, about once an hour, once you charge (you create this file when you set up charging).
QUOTE="$NGINX_DIR/aipaygen-quote.conf"
if [ -f "$QUOTE" ] && stale "$QUOTE" 50; then
  get "$API/v1/gateway/quote/$ROUTE?format=nginx" "$QUOTE" "# AIPayGen pay-per-crawl quote" "^set [$]aipaygen_quote_(json|b64) '[^']*';\$" 2 || rc=1
fi

# 4. nginx reads these files when it loads its configuration: reload only when one changed, and only
#    if nginx -t passes with it; otherwise put the last good file back.
if [ -n "$changed" ]; then
  if command -v nginx >/dev/null 2>&1; then
    if nginx -t >/dev/null 2>&1; then
      nginx -s reload >/dev/null 2>&1 || true
    else
      for f in $changed; do
        if [ -f "$f.old" ]; then mv "$f.old" "$f"; else rm -f "$f"; fi
      done
      echo "aipaygen: nginx -t failed with the new files, so the previous ones were put back." >&2
      rc=1
    fi
  fi
  for f in $changed; do rm -f "$f.old"; done
fi
exit $rc
