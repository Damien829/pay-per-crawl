#!/bin/sh
# AIPayGen helper for Apache. Run every 10 minutes from root's crontab:
#   */10 * * * * /usr/local/bin/aipaygen-apache.sh
# It sends the AI crawler visits Apache logged to your report, and keeps your terms file, your price
# and the AI crawler address list fresh. If AIPayGen can't be reached it keeps what it has and tries
# again next run: your site is never affected.
set -u
ROUTE="YOUR_ROUTE_ID"
SECRET="YOUR_GATEWAY_SECRET"          # the gateway secret you got at sign-up (keep this file chmod 700)
[ -r /etc/aipaygen/secret ] && SECRET="$(head -n 1 /etc/aipaygen/secret)"   # set by the one-line installer (root only, mode 600)
API="https://aipaygen.com"
DIR="/var/lib/aipaygen"
PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin"   # cron's PATH often lacks apachectl's folder
umask 022
mkdir -p "$DIR" || exit 1
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

# 1. Visit counts. Apache appends to the log, so emptying it in place is safe.
LOG="$DIR/visits.log"; TMP="$LOG.sending"
cap "$LOG"
if [ -s "$LOG" ] && [ "$SECRET" != "YOUR_GATEWAY_SECRET" ]; then
  cp "$LOG" "$TMP" && : > "$LOG"
  BODY=$(awk -F '\t' '
    $1 != "" && $1 !~ /[\\"]/ { n[$1]++; if ($2 ~ /^\// && $2 !~ /[\\"]/ && length($2) <= 200) p[$2]++ }
    # A verified crawler (its name, and the address flag the log carries as a third column) reading your AI Terms file.
    $1 != "" && $1 !~ /[\\"]/ && $2 == "/.well-known/ai-terms" && $3 == "1" && $1 != "AI crawler (by IP)" && $1 !~ / \(fake\)$/ { t[$1]++; tn = 1 }
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
      printf "}"
      if (tn) { printf ",\"terms\":{"; s = ""; for (b in t) { printf "%s\"%s\":%d", s, b, t[b]; s = "," }; printf "}" }
      printf "}"
    }' "$TMP")
  send "$API/v1/gateway/hits/$ROUTE" "$BODY"
  case $? in
    0) rm -f "$TMP"; touch "$DIR/reported" ;;
    2) rm -f "$TMP"; touch "$DIR/reported"; rc=1 ;;                          # refused for good: sending them again would fail again
    *) cat "$TMP" >> "$LOG"; rm -f "$TMP"; rc=1 ;;   # keep the visits for the next run
  esac
fi

# Installed but quiet: one empty report a day (none while counts went out), so your report shows the setup is live
# before any AI crawler comes. No visitor data in it: counts {}.
if [ "$SECRET" != "YOUR_GATEWAY_SECRET" ] && { [ ! -e "$DIR/reported" ] || [ -n "$(find "$DIR/reported" -mmin +1440 2>/dev/null)" ]; }; then
  send "$API/v1/gateway/hits/$ROUTE" '{"counts":{},"paths":{}}'
  case $? in
    0) touch "$DIR/reported" ;;
    2) touch "$DIR/reported"; rc=1 ;;   # refused for good (wrong secret, route gone): asking again would be refused again
    *) rc=1 ;;               # busy or unreachable: try again next run
  esac
fi

# True when the file is missing or older than this many minutes.
stale() { [ ! -s "$1" ] || [ -n "$(find "$1" -mmin +"$2" 2>/dev/null)" ]; }

# 2. Your terms file and your price, about once an hour.
if stale "$DIR/ai-terms.json" 50; then
  if curl -fsS -m 20 "$API/v1/gateway/terms/$ROUTE" -o "$DIR/ai-terms.json.new" 2>/dev/null && [ -s "$DIR/ai-terms.json.new" ]; then
    mv "$DIR/ai-terms.json.new" "$DIR/ai-terms.json"
  else rm -f "$DIR/ai-terms.json.new"; rc=1; fi
  if curl -fsS -m 20 "$API/v1/gateway/quote/$ROUTE?format=apache" -o "$DIR/quote.new" 2>/dev/null; then
    case "$(sed -n 1p "$DIR/quote.new")" in
      charging)
        sed -n 2p "$DIR/quote.new" | tr -d '\r\n' > "$DIR/quote.b64.new"
        sed -n 3p "$DIR/quote.new" > "$DIR/quote.json.new"
        if [ -s "$DIR/quote.b64.new" ] && [ -s "$DIR/quote.json.new" ]; then
          mv "$DIR/quote.b64.new" "$DIR/quote.b64"; mv "$DIR/quote.json.new" "$DIR/quote.json"; : > "$DIR/charging"
        fi ;;
      report-only) rm -f "$DIR/charging" ;;
    esac
  else rc=1; fi
  rm -f "$DIR/quote.new" "$DIR/quote.b64.new" "$DIR/quote.json.new"
fi

# 3. AI crawler addresses, once a day. Apache reads this file at start, so it is reloaded (below) when the
#    list changed, and only if Apache says the configuration is still valid.
changed=""
if stale "$DIR/ai-ips.conf" 1440; then
  if curl -fsS -m 30 "$API/v1/ai_bot_ips?format=apache" -o "$DIR/ai-ips.new" 2>/dev/null && grep -q '^SetEnvIfExpr ' "$DIR/ai-ips.new"; then
    if cmp -s "$DIR/ai-ips.new" "$DIR/ai-ips.conf" 2>/dev/null; then
      rm -f "$DIR/ai-ips.new"; touch "$DIR/ai-ips.conf"
    else
      if [ -f "$DIR/ai-ips.conf" ]; then cp "$DIR/ai-ips.conf" "$DIR/ai-ips.conf.old"; fi
      mv "$DIR/ai-ips.new" "$DIR/ai-ips.conf"; changed="$changed $DIR/ai-ips.conf"
    fi
  else rm -f "$DIR/ai-ips.new"; rc=1; fi
fi

# The AI crawler names file: exactly our header, the one SetEnvIfNoCase line with only crawler names in its group, and
# SetEnvIfExpr lines of exactly the shape we generate, one per name. Anything else is refused; the last good file stays.
# A name that would match people's browsers (under 4 characters, a browser token, or found in a browser's user agent),
# or a list under half the size of the one in place ($2), is refused too.
strict_get() { curl -fsS --proto =https --max-filesize 65536 --max-time 20 "$1" -o "$2" 2>/dev/null; }
bots_ok() {
  awk -v cur="${2:-}" '
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
    BEGIN { a = "\047"; p3 = "SetEnvIfExpr \"reqenv(" a "aipaygen_ai_list" a ") == " a "1" a " && reqenv(" a "aipaygen_ai_ip" a ") != " a "1" a " && reqenv(" a "aipaygen_bot" a ") =~ /^"; m3 = "$/i\" \"aipaygen_bot="; s3 = " (fake)\""; p2 = "SetEnvIfNoCase User-Agent \"("; s2 = ")\" aipaygen_bot=$1" }
    NR == 1 { ok = ($0 == "# AIPayGen AI crawler names v1"); next }
    NR == 2 { n2 = names(mid($0, p2, s2)); ok = ok && n2; next }
    { r = mid($0, p3, s3); i = index(r, m3)
      if (i < 2) { ok = 0; next }
      e = substr(r, 1, i - 1); n = substr(r, i + length(m3)); u = e; gsub(/\\-/, "-", u)
      ok = ok && n ~ /^[A-Za-z0-9][-A-Za-z0-9]*$/ && ok_name(n) && u == n && e ~ /^[-A-Za-z0-9\\]+$/ && e !~ /\\[^-]/ && e !~ /\\$/ }
    END { exit !(ok && NR >= 2 && !(n2 * 2 < count(cur, p2, s2))) }' "$1"
}

# 4. The AI crawler names, once a day, and at once while the file is missing or still the installer's placeholder.
if stale "$DIR/bots.conf" 1440 || [ "$(head -n 1 "$DIR/bots.conf" 2>/dev/null)" != "# AIPayGen AI crawler names v1" ]; then
  if strict_get "$API/v1/gateway/bots?format=apache" "$DIR/bots.new" && bots_ok "$DIR/bots.new" "$DIR/bots.conf"; then
    if cmp -s "$DIR/bots.new" "$DIR/bots.conf" 2>/dev/null; then
      rm -f "$DIR/bots.new"; touch "$DIR/bots.conf"
    else
      if [ -f "$DIR/bots.conf" ]; then cp "$DIR/bots.conf" "$DIR/bots.conf.old"; fi
      mv "$DIR/bots.new" "$DIR/bots.conf"; changed="$changed $DIR/bots.conf"
    fi
  else rm -f "$DIR/bots.new"; rc=1; fi
fi

# 5. Apache reads these files when it starts: reload once when one changed, and only if Apache says the configuration
#    is still valid; otherwise put each last good file back.
if [ -n "$changed" ]; then
  CTL=$(command -v apachectl || command -v apache2ctl || true)
  if [ -n "$CTL" ]; then
    if "$CTL" configtest >/dev/null 2>&1; then "$CTL" graceful >/dev/null 2>&1 || true
    else
      for f in $changed; do if [ -f "$f.old" ]; then mv "$f.old" "$f"; else rm -f "$f"; fi; done
      rc=1
    fi
  fi
  for f in $changed; do rm -f "$f.old"; done
fi
exit $rc
