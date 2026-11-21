#!/bin/sh
# AIPayGen pay-per-crawl installer for Apache (the free AI crawler report; charging is turned on later in your
# AIPayGen settings). Read it before you run it: every step is below, and it changes nothing until step 5.
#
#   Download, read, run:   curl -fsSLo aipaygen-install.sh https://aipaygen.com/install/apache
#                          sha256sum aipaygen-install.sh     # compare with https://github.com/Damien829/pay-per-crawl/blob/main/installers/aipaygen-install-apache.sh
#                          less aipaygen-install.sh
#                          sudo sh aipaygen-install.sh --route YOUR_ROUTE_ID
#   Or in one line:        curl -fsSL https://aipaygen.com/install/apache | sudo sh -s -- --route YOUR_ROUTE_ID
#
# Options: --route ID (required to install), --secret-file PATH (a root-owned file, mode 600, holding your gateway
# secret; without it you're asked for it, hidden), --dry-run (show the plan, change nothing), --upgrade (rewrite only
# this installer's own files), --uninstall (remove exactly what it added).
#
# Your gateway secret is never on a command line, in the environment, in cron or in a log: it's kept in
# /etc/aipaygen/secret (root only, mode 600), which the report script reads.
#
# What it does: 1. checks this is Apache on a Debian/Ubuntu layout and finds exactly one site block for your
# site (anything else: it changes nothing and prints the one line to add by hand); 2. writes its own files (listed
# below); 3. adds one include line to that site block, after backing the file up to /etc/aipaygen/backup; 4. checks
# the configuration (apachectl configtest): if that fails, it undoes everything; 5. adds a cron job, reloads, and makes one test
# visit so your report shows a first count.
set -eu
umask 022
# Only the installer's own tests use a scratch folder standing in for /: they set both variables. Anything else (a root
# shell or sudo -E keeping a caller's environment) is ignored, so this always works on the real /.
R=""
if [ "${AIPAYGEN_TEST:-}" = 1 ]; then R="${AIPAYGEN_TEST_ROOT:-}"; fi
KIND="apache"
API="https://aipaygen.com"
HOST_CHECK="apachectl configtest"
ROUTE=""; SECRET_FILE=""; MODE="install"; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --route) ROUTE="${2:-}"; shift 2 ;;
    --secret-file) SECRET_FILE="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --upgrade) MODE="upgrade"; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    *) echo "aipaygen: unknown option $1" >&2; exit 2 ;;
  esac
done

ETC="$R/etc/aipaygen"; MANIFEST="$ETC/installed"; BACKUP="$ETC/backup"
LOGDIR="$R/var/log/aipaygen"; LOGF="$LOGDIR/install.log"
CRON="$R/etc/cron.d/aipaygen"
MARK="# aipaygen: AI crawler report (remove with: sh aipaygen-install.sh --uninstall)"
say() { printf '%s\n' "$*"; }
# Paths as they are on the real server: the test folder taken off, only when there is one (sed refuses an empty pattern).
unroot() { if [ -n "$R" ]; then printf '%s' "$1" | sed "s#$R##g"; else printf '%s' "$1"; fi; }
# The log exists only once this installer has started changing things (a refusal before that leaves no trace).
log() { [ -d "$LOGDIR" ] && [ "$DRY" != 1 ] && printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOGF" 2>/dev/null || true; }
die() { say "aipaygen: $*" >&2; log "stopped: $*"; exit 1; }

if [ -z "$R" ] && [ "$(id -u)" != 0 ]; then die "run it as root (sudo)"; fi

# The web server's own commands and folders.
if [ "$KIND" = nginx ]; then
  CTL="nginx"; TEST="nginx -t"; RELOAD="nginx -s reload"
  SITES="$R/etc/nginx/sites-enabled $R/etc/nginx/conf.d"
  REPORT="$R/usr/local/bin/aipaygen-report.sh"
  OURS="$R/etc/nginx/conf.d/aipaygen.conf $R/etc/nginx/snippets/aipaygen-site.conf $R/etc/nginx/snippets/aipaygen-log.conf"
  INC_SITE="include /etc/nginx/snippets/aipaygen-site.conf;"
  INC_LOG="include /etc/nginx/snippets/aipaygen-log.conf;"
else
  CTL="$(command -v apachectl || command -v apache2ctl || echo apachectl)"; TEST="$CTL configtest"; RELOAD="$CTL graceful"
  SITES="$R/etc/apache2/sites-enabled"
  REPORT="$R/usr/local/bin/aipaygen-apache.sh"
  OURS="$R/etc/apache2/aipaygen-site.conf"
  INC_SITE="Include /etc/apache2/aipaygen-site.conf"
  INC_LOG=""
fi

# ---------- uninstall: remove exactly what the manifest lists ----------
if [ "$MODE" = uninstall ]; then
  [ -f "$MANIFEST" ] || die "nothing to remove: no AIPayGen install found ($MANIFEST)"
  while read -r what path; do
    case "$what" in
      edited)
        b="$BACKUP/$(printf '%s' "$path" | tr '/' '_')"
        # Our lines are the marker and the include(s) right after it; everything else in the file is theirs.
        awk -v m="$MARK" -v a="$INC_SITE" -v l="$INC_LOG" '
          { t = $0; sub(/^[ \t]+/, "", t) }
          t == m { skip = 1; next }
          skip && (t == a || (l != "" && t == l)) { next }
          { skip = 0; print }' "$R$path" > "$R$path.aipaygen-tmp"
        if [ -f "$b" ] && cmp -s "$R$path.aipaygen-tmp" "$b"; then cat "$b" > "$R$path"; rm -f "$b"
        else cat "$R$path.aipaygen-tmp" > "$R$path"; if [ -f "$b" ]; then say "Kept your later edits in $path; its original is still in $b."; fi; fi
        rm -f "$R$path.aipaygen-tmp" ;;
      created) rm -f "$R$path" ;;
    esac
  done < "$MANIFEST"
  rm -f "$CRON"
  if [ "$KIND" = nginx ]; then rm -f "$R/etc/nginx/aipaygen-ai-ips.conf" "$R/etc/nginx/aipaygen-bots.conf" "$R/var/log/nginx/aipaygen-ai.log" "$R/var/log/nginx/aipaygen-ai.log.sending"; else rm -rf "$R/var/lib/aipaygen"; fi
  if $TEST >/dev/null 2>&1; then $RELOAD >/dev/null 2>&1 || true; else say "aipaygen: removed, but the configuration check failed; look at the output of: $TEST"; fi
  rm -rf "$ETC" "$LOGDIR"
  say "AIPayGen pay-per-crawl is removed from this server. To delete your route and its data at AIPayGen too: $API/pay-per-crawl/delete"
  exit 0
fi

# ---------- install or upgrade ----------
if [ "$MODE" = install ] && [ -f "$MANIFEST" ]; then
  die "already installed. Use --uninstall first, or --upgrade to update this installer's own files (your site's configuration is not touched)."
fi
if [ "$MODE" = upgrade ]; then
  [ -f "$MANIFEST" ] || die "nothing to upgrade: no AIPayGen install found ($MANIFEST)"
  ROUTE="$(awk '$1 == "route" { print $2 }' "$MANIFEST")"
fi
printf '%s' "$ROUTE" | grep -Eq '^[0-9a-f]{12}$' || die "give your route id: --route ID (12 characters, from your sign-up or report)"

command -v "$CTL" >/dev/null 2>&1 || die "$KIND isn't installed here (no $CTL). Use the setup guide for your server instead: $API/pay-per-crawl/setup/$KIND?route=$ROUTE"
[ -d "$R/etc/cron.d" ] || die "this server has no /etc/cron.d. Use the setup guide instead: $API/pay-per-crawl/setup/$KIND?route=$ROUTE"

# The site's host, from AIPayGen (public, the route's own address).
HOST="$(curl -fsS -m 10 "$API/v1/gateway/terms/$ROUTE" 2>/dev/null | sed -n 's/^[ \t]*"site":[ \t]*"https\{0,1\}:\/\/\([A-Za-z0-9.-]*\)".*/\1/p' | head -n 1 | tr 'A-Z' 'a-z')"
[ -n "$HOST" ] || die "couldn't read route $ROUTE from AIPayGen. Check the route id, or try again in a minute."

manual() {
  say ""
  say "Nothing was changed. $1"
  say "Add this line by hand inside your site's block for $HOST, then run: $HOST_CHECK"
  say "    $INC_SITE"
  [ -n "$INC_LOG" ] && say "  and, if that block has its own access_log line:  $INC_LOG"
  say "Step by step: $API/pay-per-crawl/setup/$KIND?route=$ROUTE"
  exit 0
}

# Which site blocks serve this host (a block that only redirects, like certbot's port-80 one, doesn't count).
# Prints: file  line-of-server_name  has-its-own-access_log
find_blocks() {
  for f in $SITES; do
    [ -e "$f" ] || continue
    for g in "$f"/*; do
      [ -f "$g" ] || continue
      case "$g" in *aipaygen*) continue ;; esac
      if [ "$KIND" = nginx ]; then
        awk -v host="$HOST" -v file="$g" '
          { line = $0; sub(/#.*/, "", line) }
          depth == 0 && line ~ /^[ \t]*server[ \t]*\{/ { inb = 1; m = 0; sn = 0; redir = 0; serve = 0; alog = 0 }
          inb && line ~ /^[ \t]*server_name[ \t]/ { n = split(line, w, /[ \t;]+/); for (i = 2; i <= n; i++) if (tolower(w[i]) == host) { m = 1; sn = NR } }
          inb && line ~ /^[ \t]*return[ \t]+30[1278]/ { redir = 1 }
          inb && line ~ /^[ \t]*(location|root|proxy_pass|fastcgi_pass|uwsgi_pass|alias|try_files)[ \t]/ { serve = 1 }
          inb && depth == 1 && line ~ /^[ \t]*access_log[ \t]/ { alog = 1 }
          { o = gsub(/\{/, "{", line); c = gsub(/\}/, "}", line); depth += o - c }
          inb && depth == 0 { if (m && !(redir && !serve)) print file, sn, alog; inb = 0 }' "$g"
      else
        awk -v host="$HOST" -v file="$g" '
          { line = $0; sub(/^[ \t]+/, "", line) }
          tolower(line) ~ /^<virtualhost[ \t>]/ { inb = 1; m = 0; sn = 0; redir = 0; next }
          tolower(line) ~ /^<\/virtualhost>/ { if (inb && m && !redir) print file, sn, 0; inb = 0; next }
          inb && tolower(line) ~ /^(servername|serveralias)[ \t]/ { n = split(line, w, /[ \t]+/); for (i = 2; i <= n; i++) if (tolower(w[i]) == host) { m = 1; if (tolower(w[1]) == "servername" || !sn) sn = NR } }
          inb && tolower(line) ~ /^redirect(permanent)?[ \t]+(permanent[ \t]+|301[ \t]+)?\/[ \t]+https?:/ { redir = 1 }
          inb && tolower(line) ~ /^rewriterule[ \t].*https:\/\/.*\[.*r(=|,|\])/ { redir = 1 }' "$g"
      fi
    done
  done
}

# The layout this needs: nginx reading conf.d/*.conf inside http {}; Apache with the modules its lines use.
if [ "$KIND" = nginx ]; then
  grep -Eq 'include[[:space:]]+[^;]*conf\.d/\*\.conf' "$R/etc/nginx/nginx.conf" 2>/dev/null || manual "Your nginx.conf doesn't include conf.d/*.conf, so this installer can't add its settings safely."
else
  mods="$($CTL -M 2>/dev/null || true)"
  for mod in rewrite headers setenvif; do
    printf '%s' "$mods" | grep -q "${mod}_module" || manual "Apache's $mod module is off. Turn it on first (sudo a2enmod $mod), then run this again."
  done
fi

BLOCKS="$(find_blocks)"
N="$(printf '%s' "$BLOCKS" | grep -c . || true)"
if [ "$MODE" = install ]; then
  if [ "$N" = 0 ]; then
    manual "Found no site block that serves $HOST: no server_name (nginx) or ServerName/ServerAlias (Apache) line names it exactly, in $(unroot "$SITES"). A block that only redirects (like certbot's port-80 one) doesn't count, and braces inside quoted strings can hide a block from this check."
  elif [ "$N" != 1 ]; then
    manual "Found $N site blocks that serve $HOST, and only one can be changed automatically: $(printf '%s' "$BLOCKS" | awk -v r="$R" '{ f = $1; sub("^" r, "", f); printf "%s%s line %s", (NR > 1 ? ", " : ""), f, $2 }')."
  fi
  SITE_FILE="$(printf '%s' "$BLOCKS" | awk '{ print $1 }')"; SITE_LINE="$(printf '%s' "$BLOCKS" | awk '{ print $2 }')"; SITE_ALOG="$(printf '%s' "$BLOCKS" | awk '{ print $3 }')"
fi

say "AIPayGen pay-per-crawl ($KIND), route $ROUTE, site $HOST."
if [ "$DRY" = 1 ]; then
  say "Would write: /etc/aipaygen/secret, $(unroot "$OURS"), ${REPORT#$R}, /etc/cron.d/aipaygen"
  [ "$MODE" = install ] && say "Would add after line $SITE_LINE of ${SITE_FILE#$R}:  $INC_SITE"
  say "Then: $HOST_CHECK, and a reload. (Dry run: nothing changed.)"
  exit 0
fi

# ---------- the gateway secret: from a root-only file, or typed (hidden); never in argv, env, cron or a log ----------
SECRET=""
if [ "$MODE" = install ]; then
  if [ -n "$SECRET_FILE" ]; then
    [ -f "$SECRET_FILE" ] && [ ! -L "$SECRET_FILE" ] || die "--secret-file must be a regular file"
    set -- $(ls -ln "$SECRET_FILE")
    [ "$3" = "$(id -u)" ] || die "--secret-file must belong to root"
    case "$1" in -rw-------|-r--------|-rw-------?|-r--------?) ;; *) die "--secret-file must be mode 600 (chmod 600 $SECRET_FILE)" ;; esac
    SECRET="$(head -n 1 "$SECRET_FILE" | tr -d '\r\n ')"
  else
    ( : < /dev/tty ) 2>/dev/null || die "no terminal to ask for your gateway secret: use --secret-file PATH"
    printf 'Your gateway secret (from your sign-up; the input is hidden): ' > /dev/tty
    stty -echo < /dev/tty 2>/dev/null || true
    trap 'stty echo < /dev/tty 2>/dev/null || true' EXIT
    IFS= read -r SECRET < /dev/tty || true
    stty echo < /dev/tty 2>/dev/null || true
    printf '\n' > /dev/tty
  fi
  printf '%s' "$SECRET" | grep -Eq '^[A-Za-z0-9]{8,200}$' || die "that doesn't look like a gateway secret (letters and digits). Lost it? $API/pay-per-crawl/new-secret"
fi

CREATED=""
created() { CREATED="$CREATED $1"; }
rollback() {
  log "rolling back"
  for f in $CREATED; do rm -f "$f"; done
  if [ -n "${SITE_FILE:-}" ] && [ -f "$BACKUP/$(printf '%s' "${SITE_FILE#$R}" | tr '/' '_')" ]; then
    cat "$BACKUP/$(printf '%s' "${SITE_FILE#$R}" | tr '/' '_')" > "$SITE_FILE"
  fi
  if [ "$MODE" = install ]; then
    rm -rf "$ETC" "$LOGDIR"
    if [ "$KIND" = apache ]; then rm -rf "$R/var/lib/aipaygen"; fi
  fi
}

# ---------- write our own files ----------
mkdir -p "$ETC" "$BACKUP" "$LOGDIR" "$(dirname "$REPORT")"
chmod 700 "$ETC"; chmod 755 "$LOGDIR"
log "start $MODE $KIND route $ROUTE host $HOST"
if [ "$MODE" = install ]; then
  ( umask 077; printf '%s\n' "$SECRET" > "$ETC/secret" )
  chmod 600 "$ETC/secret"
  if [ "$KIND" = apache ]; then
    ( umask 077; printf 'Define AIPAYGEN_SECRET %s\n' "$SECRET" > "$ETC/apache-secret.conf" )
    chmod 600 "$ETC/apache-secret.conf"
  fi
fi
SECRET=""   # not needed any more in this process

put() {   # put PATH MODE: the payload on stdin, the route filled in
  if [ "$MODE" = install ]; then created "$1"; fi
  if [ "$MODE" = upgrade ] && [ -f "$1" ]; then cp "$1" "$1.aipaygen-old"; fi
  mkdir -p "$(dirname "$1")"
  sed "s/__AIPAYGEN_ROUTE__/$ROUTE/g" > "$1"
  chmod "$2" "$1"
  log "wrote ${1#$R}"
}
put "$REPORT" 700 <<'AIPAYGEN_EOF'
#!/bin/sh
# AIPayGen helper for Apache. Run every 10 minutes from root's crontab:
#   */10 * * * * /usr/local/bin/aipaygen-apache.sh
# It sends the AI crawler visits Apache logged to your report, and keeps your terms file, your price
# and the AI crawler address list fresh. If AIPayGen can't be reached it keeps what it has and tries
# again next run: your site is never affected.
set -u
ROUTE="__AIPAYGEN_ROUTE__"
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
AIPAYGEN_EOF
mkdir -p "$R/var/lib/aipaygen"
put "$R/etc/apache2/aipaygen-site.conf" 644 <<'AIPAYGEN_EOF'
# AIPayGen pay-per-crawl (written by the AIPayGen installer). Included from your site's <VirtualHost>.
Include /etc/aipaygen/apache-secret.conf
# Which requests are AI crawlers: by address first (the lists AI companies publish, named at
# https://aipaygen.com/ai-crawlers#checkable; the script keeps this file fresh), then by name.
IncludeOptional /var/lib/aipaygen/ai-ips.conf
# The AI crawler names, and "<name> (fake)" for a name whose operator publishes its addresses used from outside them
# (only once ai-ips.conf has loaded): the script keeps this file fresh.
IncludeOptional /var/lib/aipaygen/bots.conf
# Their visits, one line each (crawler name and path only), for your report.
CustomLog /var/lib/aipaygen/visits.log "%<{aipaygen_bot}e\t%U" env=aipaygen_bot

<Directory /var/lib/aipaygen>
  Require all granted
  ForceType application/json
  Header set Access-Control-Allow-Origin "*"
</Directory>
# An unpaid AI crawler gets your price from a file on this server; it never reaches AIPayGen.
ErrorDocument 402 /__aipaygen_402
Header always set payment-required "expr=%{file:/var/lib/aipaygen/quote.b64}" "expr=%{REQUEST_STATUS} -eq 402"
Header always set cache-control "no-store" "expr=%{REQUEST_STATUS} -eq 402"
# AI Terms: this route's machine-readable terms, which a 402 must link.
Header always set link "<https://aipaygen.com/v1/gateway/terms/__AIPAYGEN_ROUTE__>; rel=\"ai-terms\"" "expr=%{REQUEST_STATUS} -eq 402"

RewriteEngine On
# This site's AI Terms (per-use terms for AI), served at /.well-known/ai-terms.
RewriteCond /var/lib/aipaygen/ai-terms.json -f
RewriteRule ^/\.well-known/ai-terms$ /var/lib/aipaygen/ai-terms.json [L]
RewriteCond %{ENV:REDIRECT_STATUS} =402
RewriteRule ^/__aipaygen_402$ /var/lib/aipaygen/quote.json [L]

# Charge: only while your route charges (the script creates /var/lib/aipaygen/charging then and
# removes it in report-only mode, so you switch modes in your AIPayGen settings, not here).
RewriteCond %{ENV:aipaygen_bot} .
# The gateway fetching a page it was paid for: serve it normally. (the secret comes from /etc/aipaygen/apache-secret.conf, root only.)
RewriteCond %{HTTP:X-AIPayGen-Gateway-Secret} !=${AIPAYGEN_SECRET}
# robots.txt and the terms file are free for every crawler: they are how it learns your rules and the price.
# Lines to add to robots.txt, written from your AI Terms (IETF aipref Content-Usage; training-only crawlers): https://aipaygen.com/v1/gateway/robots/__AIPAYGEN_ROUTE__
RewriteCond %{REQUEST_URI} !^/(robots\.txt|\.well-known/ai-terms|__aipaygen_402)$
RewriteCond %{HTTP:Payment-Signature}%{HTTP:X-Payment} ^$
RewriteCond /var/lib/aipaygen/charging -f
RewriteRule ^ - [R=402,L]

# A crawler retrying with a payment goes to AIPayGen, which verifies it, fetches the page and pays you.
<IfModule mod_ssl.c>
  SSLProxyEngine on
</IfModule>
<IfModule mod_proxy_http.c>
  RewriteCond %{HTTP:X-AIPayGen-Gateway-Secret} !=${AIPAYGEN_SECRET}
  RewriteCond %{REQUEST_URI} !^/(robots\.txt|\.well-known/ai-terms)$
  RewriteCond %{HTTP:Payment-Signature}%{HTTP:X-Payment} .
  RewriteCond /var/lib/aipaygen/charging -f
  RewriteRule ^/?(.*)$ https://aipaygen.com/g/__AIPAYGEN_ROUTE__/$1 [P,L,QSA]
</IfModule>
AIPAYGEN_EOF

# ---------- the one edit to their configuration ----------
if [ "$MODE" = install ]; then
  b="$BACKUP/$(printf '%s' "${SITE_FILE#$R}" | tr '/' '_')"
  cp "$SITE_FILE" "$b"; chmod 600 "$b"
  ind="$(sed -n "${SITE_LINE}p" "$SITE_FILE" | sed 's/[^ \t].*//')"
  awk -v n="$SITE_LINE" -v ind="$ind" -v m="$MARK" -v a="$INC_SITE" -v l="$INC_LOG" -v alog="$SITE_ALOG" '
    { print } NR == n { print ind m; print ind a; if (alog == 1 && l != "") print ind l }' "$b" > "$SITE_FILE.aipaygen-tmp"
  cat "$SITE_FILE.aipaygen-tmp" > "$SITE_FILE"; rm -f "$SITE_FILE.aipaygen-tmp"
  log "added the include to ${SITE_FILE#$R} after line $SITE_LINE (backup in ${b#$R})"
fi

# ---------- check, or undo everything ----------
if ! OUT="$($TEST 2>&1)"; then
  say "$OUT" >&2
  if [ "$MODE" = upgrade ]; then for f in $OURS $REPORT; do if [ -f "$f.aipaygen-old" ]; then mv "$f.aipaygen-old" "$f"; fi; done; fi
  rollback
  die "the configuration check failed, so everything this installer did was undone. Nothing on your site changed."
fi
for f in $OURS $REPORT; do rm -f "$f.aipaygen-old"; done

# ---------- the manifest (what --uninstall removes), cron, reload ----------
if [ "$MODE" = install ]; then
  {
    printf 'route %s\n' "$ROUTE"
    for f in $CREATED; do printf 'created %s\n' "${f#$R}"; done
    printf 'created /etc/cron.d/aipaygen\n'
    printf 'edited %s\n' "${SITE_FILE#$R}"
  } > "$MANIFEST"
  chmod 600 "$MANIFEST"
fi
printf '*/10 * * * * root %s >/dev/null 2>&1\n' "${REPORT#$R}" > "$CRON"
chmod 644 "$CRON"
$RELOAD >/dev/null 2>&1 || die "the reload failed; your previous configuration is still running. Run: $HOST_CHECK"
log "reloaded"
[ "$MODE" = upgrade ] && { say "Upgraded this installer's own files. Your site's configuration was not touched."; exit 0; }

# ---------- one test visit, and the first count ----------
if [ -z "$R" ]; then
  sh "$REPORT" >/dev/null 2>&1 || true   # fetches the AI crawler address list (and reloads if it changed)
  curl -s -o /dev/null -m 10 -A "GPTBot" --resolve "$HOST:443:127.0.0.1" "https://$HOST/" || curl -s -o /dev/null -m 10 -A "GPTBot" --resolve "$HOST:80:127.0.0.1" "http://$HOST/" || true
  sh "$REPORT" >/dev/null 2>&1 || true   # sends that visit to your report
fi
say ""
say "Done. AI crawler visits to $HOST are now counted for your report (sent every 10 minutes)."
say "Your test visit appears as 'GPTBot (fake)': it came from this server, not an OpenAI address, which is the check working. It also counts once in your totals."
TOKEN="$(printf '%s:report' "$(cat "$ETC/secret")" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-24)"
say "Your private report (keep this link to yourself): $API/pay-per-crawl/report/$ROUTE?t=$TOKEN"
say "To remove it all later: sh aipaygen-install.sh --uninstall"
