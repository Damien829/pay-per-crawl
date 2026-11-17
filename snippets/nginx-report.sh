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
    0) rm -f "$TMP" ;;
    2) rm -f "$TMP"; rc=1 ;;                          # refused for good: sending them again would fail again
    *) cat "$TMP" >> "$LOG"; rm -f "$TMP"; rc=1 ;;   # keep the visits for the next run
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
# get URL FILE HEAD LINE MIN: download to FILE.new, check it, and move it into place only if it changed.
changed=""
get() {
  if curl -fsS -m 30 "$1" -o "$2.new" 2>/dev/null && looks_ok "$2.new" "$3" "$4" "$5"; then
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
