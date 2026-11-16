#!/bin/sh
# AIPayGen helper for Apache. Run every 10 minutes from root's crontab:
#   */10 * * * * /usr/local/bin/aipaygen-apache.sh
# It sends the AI crawler visits Apache logged to your report, and keeps your terms file, your price
# and the AI crawler address list fresh. If AIPayGen can't be reached it keeps what it has and tries
# again next run: your site is never affected.
set -u
ROUTE="YOUR_ROUTE_ID"
SECRET="YOUR_GATEWAY_SECRET"          # the gateway secret you got at sign-up (keep this file chmod 700)
API="https://aipaygen.com"
DIR="/var/lib/aipaygen"
umask 022
mkdir -p "$DIR" || exit 1
rc=0

# 1. Visit counts. Apache appends to the log, so emptying it in place is safe.
LOG="$DIR/visits.log"; TMP="$LOG.sending"
if [ -s "$LOG" ] && [ "$SECRET" != "YOUR_GATEWAY_SECRET" ]; then
  cp "$LOG" "$TMP" && : > "$LOG"
  BODY=$(awk -F '\t' '
    $1 != "" && $1 !~ /[\\"]/ { n[$1]++; if ($2 ~ /^\// && $2 !~ /[\\"]/ && length($2) <= 200) p[$2]++ }
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
  if curl -fsS -m 20 -X POST "$API/v1/gateway/hits/$ROUTE" \
       -H "content-type: application/json" -H "x-aipaygen-gateway-secret: $SECRET" --data-binary "$BODY" >/dev/null 2>&1; then
    rm -f "$TMP"
  else
    cat "$TMP" >> "$LOG"; rm -f "$TMP"; rc=1   # keep the visits for the next run
  fi
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

# 3. AI crawler addresses, once a day. Apache reads this file at start, so it is reloaded when the
#    list changed, and only if Apache says the configuration is still valid.
if stale "$DIR/ai-ips.conf" 1440; then
  if curl -fsS -m 30 "$API/v1/ai_bot_ips?format=apache" -o "$DIR/ai-ips.new" 2>/dev/null && grep -q '^SetEnvIfExpr ' "$DIR/ai-ips.new"; then
    if cmp -s "$DIR/ai-ips.new" "$DIR/ai-ips.conf" 2>/dev/null; then
      rm -f "$DIR/ai-ips.new"; touch "$DIR/ai-ips.conf"
    else
      [ -f "$DIR/ai-ips.conf" ] && cp "$DIR/ai-ips.conf" "$DIR/ai-ips.old"
      mv "$DIR/ai-ips.new" "$DIR/ai-ips.conf"
      CTL=$(command -v apachectl || command -v apache2ctl || true)
      if [ -n "$CTL" ]; then
        if "$CTL" configtest >/dev/null 2>&1; then "$CTL" graceful >/dev/null 2>&1 || true
        elif [ -f "$DIR/ai-ips.old" ]; then mv "$DIR/ai-ips.old" "$DIR/ai-ips.conf"   # put the last good list back
        else rm -f "$DIR/ai-ips.conf"; fi
      fi
      rm -f "$DIR/ai-ips.old"
    fi
  else rm -f "$DIR/ai-ips.new"; rc=1; fi
fi
exit $rc
