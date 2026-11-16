#!/bin/sh
# AIPayGen AI crawler report for nginx: sends the AI crawler visits nginx logged to your report,
# then empties the log. Run every 10 minutes from root's crontab:  */10 * * * * /usr/local/bin/aipaygen-report.sh
set -eu
ROUTE="YOUR_ROUTE_ID"
SECRET="YOUR_GATEWAY_SECRET"          # the gateway secret you got at sign-up (keep this file chmod 700)
LOG="/var/log/nginx/aipaygen-ai.log"
[ -s "$LOG" ] || exit 0
TMP="$LOG.sending"
cp "$LOG" "$TMP" && : > "$LOG"        # nginx appends, so emptying the file in place is safe
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
if curl -fsS -m 20 -X POST "https://aipaygen.com/v1/gateway/hits/$ROUTE" \
     -H "content-type: application/json" -H "x-aipaygen-gateway-secret: $SECRET" --data-binary "$BODY" >/dev/null; then
  rm -f "$TMP"
else
  cat "$TMP" >> "$LOG"; rm -f "$TMP"   # keep the visits for the next run
  exit 1
fi
