# aipaygen_middleware.py: pay-per-crawl for Django via AIPayGen (Python 3.8+, no extra packages).
# 1. Save this file next to settings.py.
# 2. Add "yourproject.aipaygen_middleware.AIPayGenMiddleware" near the top of MIDDLEWARE in settings.py.
# 3. Set AIPAYGEN_SECRET (the gateway secret you got at sign-up) in the environment and restart.
# 4. Behind a proxy or load balancer (nginx in front of gunicorn, an AWS load balancer...), also set
#    AIPAYGEN_TRUSTED_PROXIES to its addresses, comma-separated, e.g. 127.0.0.1 or 10.0.0.0/8. Only then is the
#    visitor's address read from X-Forwarded-For: without it that header is ignored, because any client can send it
#    (and claim a crawler's published address to be treated as that crawler).
# People and search engines browse free. Report-only routes count AI crawlers and still serve the page.
# Optional: with PyNaCl or cryptography installed, signed AI agents (Web Bot Auth) are checked too.
import base64, ipaddress, json, os, re, threading, time, urllib.error, urllib.request

AIPAYGEN = "https://aipaygen.com"
ROUTE = os.environ.get("AIPAYGEN_ROUTE", "YOUR_ROUTE_ID")
GATEWAY = AIPAYGEN + "/g/" + ROUTE
AI_BOTS = re.compile("|".join(map(re.escape, ["GPTBot","OAI-SearchBot","ChatGPT-User","ClaudeBot","Claude-User","Claude-SearchBot","anthropic-ai","PerplexityBot","Perplexity-User","GoogleOther","CCBot","Bytespider","Amazonbot","meta-externalagent","FacebookBot","cohere-ai","Diffbot","YouBot","MistralAI-User","DuckAssistBot","PetalBot","Timpibot","ImagesiftBot","omgili","AI2Bot","ElevenlabsCrawler","ElevenlabsBot"])), re.I)
ASSET = re.compile("[.](css|js|mjs|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|map)$", re.I)

_lock = threading.Lock()
_state = {"quote": None, "quote_at": 0.0, "nets": {}, "nets_at": 0.0, "hits": {}, "paths": {}, "terms": {}, "n": 0, "sent_at": 0.0, "sending": False, "free_used": {}, "free_win": "", "hb_at": time.time() - 86400 + 600}


def _get(url, timeout=3):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"user-agent": "aipaygen-django/1"}), timeout=timeout) as r:
        return r.read()


def _due(key, every):
    # True for one caller when a refresh is due; it also moves the clock so a failure retries in 5 minutes.
    with _lock:
        if time.time() - _state[key] <= every:
            return False
        _state[key] = time.time() - every + 300
        return True


def _quote():
    # While AIPayGen can't be reached, one request tries again every 5 minutes; the others serve the page at once.
    if _due("quote_at", 3600):
        try:
            _state["quote"] = json.loads(_get(AIPAYGEN + "/v1/gateway/quote/" + ROUTE))
            _state["quote_at"] = time.time()
        except Exception:
            pass
    return _state["quote"]


def _net_key(version, num):
    # Networks are grouped by the address's first 8 bits (IPv4) or 16 bits (IPv6), so a lookup checks a few, not all.
    return (version, num >> 24) if version == 4 else (version, num >> 112)


def _load_nets():
    # AI crawlers that hide their name, by the address lists OpenAI, Anthropic, Perplexity, Mistral,
    # DuckDuckGo and Common Crawl publish. Runs in a background thread, never inside a request.
    try:
        nets = {}
        for line in _get(AIPAYGEN + "/v1/ai_bot_ips?format=text", timeout=10).decode().split():
            try:
                n = ipaddress.ip_network(line.strip(), strict=False)  # a bare address is one host
            except ValueError:
                continue
            # A very wide network (shorter than the bucket) goes in every bucket it covers.
            first, last = int(n.network_address), int(n.broadcast_address)
            for k in range(_net_key(n.version, first)[1], _net_key(n.version, last)[1] + 1):
                nets.setdefault((n.version, k), []).append(n)
        if nets:
            _state["nets"], _state["nets_at"] = nets, time.time()
    except Exception:
        pass


def _ai_ip(ip):
    if _due("nets_at", 86400):
        try:
            threading.Thread(target=_load_nets, daemon=True).start()
        except Exception:
            pass  # no thread available (some servers): keep the current list, never fail the request
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if addr.version == 6 and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return any(addr in n for n in _state["nets"].get(_net_key(addr.version, int(addr)), ()))


def _send_report(secret):
    every = (_state["quote"] or {}).get("report") or {"every_seconds": 60, "max_hits": 500}
    with _lock:
        if _state["sending"] or not secret:
            return
        if not _state["n"]:
            # Installed but quiet: one empty report a day (the first 10 minutes after this process starts), so the report shows the setup
            # is live before any AI crawler comes. No visitor data in it: counts {}.
            if time.time() - _state["hb_at"] < 86400:
                return
        elif _state["n"] < every.get("max_hits", 500) and time.time() - _state["sent_at"] < max(60, every.get("every_seconds", 60)):
            return
        top = dict(sorted(_state["paths"].items(), key=lambda kv: -kv[1])[:10])
        out = {"counts": _state["hits"], "paths": top}
        if _state["terms"]:
            out["terms"] = _state["terms"]  # verified crawlers that read your AI Terms file, with the visits: no request of its own
        body = json.dumps(out).encode()
        _state.update(hits={}, paths={}, terms={}, n=0, sent_at=time.time(), hb_at=time.time(), sending=True)

    def post():
        try:
            req = urllib.request.Request(AIPAYGEN + "/v1/gateway/hits/" + ROUTE, data=body, method="POST",
                                         headers={"content-type": "application/json", "x-aipaygen-gateway-secret": secret})
            urllib.request.urlopen(req, timeout=5).read()
        except Exception:
            pass
        finally:
            _state["sending"] = False

    threading.Thread(target=post, daemon=True).start()


def _sign(resp, q, page=True):
    # What the terms say, in headers crawlers already read: Link rel="ai-terms" (on the 402 and on pages served to
    # AI crawlers) and the IETF aipref Content-Usage, e.g. "train-ai=n" (on pages only: it describes the content).
    if not q:
        return resp
    terms, cu = q.get("terms"), q.get("content_usage")
    if isinstance(terms, str) and re.match(r'^https:[^\s<>"]+\Z', terms):
        link = "<" + terms + '>; rel="ai-terms"'
        old = resp.get("link", "")
        if not re.search(r'rel="?ai-terms', old):
            resp["link"] = old + ", " + link if old else link
    if page and isinstance(cu, str) and re.match(r'^[a-z-]+=[yn](, [a-z-]+=[yn]){0,5}\Z', cu):
        # Combined with the site's own, as IETF aipref combines preferences: n in either is n; the site's other
        # members are kept, and categories it doesn't state are added from ours.
        mine = dict(p.split("=") for p in cu.split(", "))
        out = []
        for p in (resp.get("content-usage", "") or "").split(","):
            t = p.strip()
            if not t:
                continue
            k = re.split(r"[=;]", t)[0]
            if k in mine:
                out.append(k + "=n" if mine.pop(k) == "n" else t)
            else:
                out.append(t)
        out += [k + "=" + v for k, v in mine.items()]
        resp["content-usage"] = ", ".join(out)
    return resp


# Signed AI agents (Web Bot Auth, IETF draft): an agent that signs its requests is checked here, with the keys of
# AIPayGen's hourly list of agents it can identify (that's not an endorsement); this never fetches anything from the
# agent itself. A known agent signing correctly is counted under its own name; a failure for a key on that list is
# "<agent> (fake)"; anything else changes nothing. Needs PyNaCl or cryptography (whichever is installed); with neither,
# nothing here runs and nothing else changes. A captured valid signature can be replayed until it expires (about 5
# minutes); that only affects counts, and any free allowance is capped per hour or day.
def _ed25519():
    try:
        from nacl.signing import VerifyKey
        from nacl.exceptions import BadSignatureError

        def verify(pub, data, sig):
            try:
                VerifyKey(pub).verify(data, sig)
                return True
            except BadSignatureError:
                return False
        return verify
    except Exception:
        pass
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        from cryptography.exceptions import InvalidSignature

        def verify(pub, data, sig):
            try:
                Ed25519PublicKey.from_public_bytes(pub).verify(sig, data)
                return True
            except InvalidSignature:
                return False
        return verify
    except Exception:
        return None


_ED25519 = _ed25519()
_state.update(wba={}, wba_at=0.0, wba_early=0.0)


def _load_wba():
    try:
        j = json.loads(_get(AIPAYGEN + "/v1/signed_agents"))
        if isinstance(j, dict) and isinstance(j.get("agents"), dict):
            _state["wba"], _state["wba_at"] = j["agents"], time.time()
    except Exception:
        pass


def _wba_refresh(early=False):
    due = _due("wba_at", 3600)
    if early and not due:
        with _lock:
            due = time.time() - _state["wba_early"] > 300
            if due:
                _state["wba_early"] = time.time()
    if due:
        try:
            threading.Thread(target=_load_wba, daemon=True).start()
        except Exception:
            pass


def _wba_str(v):
    s = str(v or "").strip()
    if len(s) < 2 or s[0] != '"' or s[-1] != '"':
        return None
    out, i = "", 1
    while i < len(s) - 1:
        c = s[i]
        if not (0x20 <= ord(c) <= 0x7e):
            return None
        if c == "\\":
            i += 1
            n = s[i] if i < len(s) - 1 else ""
            if n not in ('"', "\\"):
                return None
            out += n
        elif c == '"':
            return None
        else:
            out += c
        i += 1
    return out


def _wba_input(header):
    if not header or len(header) > 4096:
        return None
    members, depth, quote, start, i = [], 0, False, 0, 0
    while i < len(header):
        c = header[i]
        if quote:
            if c == "\\":
                i += 1
            elif c == '"':
                quote = False
        elif c == '"':
            quote = True
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
        elif c == "," and depth == 0:
            members.append(header[start:i])
            start = i + 1
        i += 1
    members.append(header[start:])
    for m in members:
        eq = m.find("=")
        if eq < 1:
            continue
        label, raw = m[:eq].strip(), m[eq + 1:].strip()
        if not re.match(r"^[a-z*][a-z0-9_.*-]*$", label) or not raw.startswith("("):
            continue
        close = raw.find(")")
        if close < 0:
            continue
        components = re.findall(r'"([^"\\]*)"', raw[1:close])
        params = {}
        for p in [x.strip() for x in raw[close + 1:].split(";") if x.strip()]:
            k = p.find("=")
            if k < 1:
                continue
            name, val = p[:k], p[k + 1:]
            if re.match(r"^-?\d{1,15}$", val):
                params[name] = int(val)
            else:
                sv = _wba_str(val)
                if sv is not None:
                    params[name] = sv
        if params.get("tag") == "web-bot-auth":
            return {"label": label, "components": components, "params": params, "raw": raw}
    return None


def _wba_sig(header, label):
    m = re.search(r"(?:^|,)\s*" + re.escape(label) + r"=:([A-Za-z0-9+/=]{1,1000}):", header or "")
    if not m:
        return None
    try:
        return base64.b64decode(m.group(1), validate=True)
    except Exception:
        return None


def _wba(request, now=None):
    # The verdict, as lane E's shared vectors define it ("none", "verified", "unchecked", "invalid:<why>"), with the
    # agent's name and whether its key is on the list (only then can a failure be called fake).
    none = {"v": "none", "bot": None, "known": False}
    if _ED25519 is None:
        return none
    h = request.headers
    get = lambda k: (lambda v: v if v is not None and len(v) <= 4096 else None)(h.get(k))
    inp, agent = _wba_input(get("signature-input")), _wba_str(get("signature-agent"))
    if not inp or agent is None or "@authority" not in inp["components"] or "signature-agent" not in inp["components"]:
        return none
    p = inp["params"]
    created, expires, keyid = p.get("created"), p.get("expires"), p.get("keyid")
    if not isinstance(created, int) or not isinstance(expires, int) or not isinstance(keyid, str) or not keyid or p.get("alg", "ed25519") != "ed25519":
        return none
    try:
        from urllib.parse import urlsplit
        a = urlsplit(agent)
        if a.scheme != "https" or a.username or a.password or (a.port not in (None, 443)) or not a.hostname:
            return none
        host = a.hostname.lower()
    except ValueError:
        return none
    sig = _wba_sig(get("signature"), inp["label"])
    if sig is None:
        return none
    _wba_refresh()
    entry = _state["wba"].get(host) if isinstance(_state["wba"], dict) else None
    entry = entry if isinstance(entry, dict) else None
    bot = entry.get("bot") if entry and isinstance(entry.get("bot"), str) and re.match(r"^[A-Za-z0-9 ._()-]{1,40}$", entry["bot"]) else None
    key = next((k.get("x") for k in (entry or {}).get("keys", []) if isinstance(k, dict) and k.get("kid") == keyid and isinstance(k.get("x"), str)), None)
    known = key is not None and bot is not None
    t = int(now if now is not None else time.time())
    if created > t + 300:
        return {"v": "invalid:not yet valid", "bot": bot, "known": known}
    if expires < t - 300 or expires <= created:
        return {"v": "invalid:expired", "bot": bot, "known": known}
    if key is None:
        if entry:
            _wba_refresh(early=True)  # a key newer than the list: ask again, at most every 5 minutes
        return {"v": "unchecked", "bot": bot, "known": False}
    lines = []
    from urllib.parse import urlsplit
    full = urlsplit(request.get_full_path())
    for c in inp["components"]:
        if c == "@authority":
            # get_host() enforces ALLOWED_HOSTS: a request carrying another site's Host (to replay a signature made for
            # that site) is refused here instead of being checked against it.
            try:
                v = request.get_host().lower()
            except Exception:
                return none
        elif c == "@method":
            v = (getattr(request, "method", None) or "GET").upper()
        elif c == "@path":
            v = full.path or "/"
        elif c == "@query":
            v = "?" + full.query if full.query else "?"
        elif c == "@scheme":
            v = "https" if request.is_secure() else "http"
        elif c.startswith("@"):
            return none
        else:
            v = get(c)
            v = v.strip() if v is not None else None
        if not v:
            return none
        lines.append('"' + c + '": ' + v)
    lines.append('"@signature-params": ' + inp["raw"])
    try:
        pub = base64.urlsafe_b64decode(key + "=" * (-len(key) % 4))
        ok = len(pub) == 32 and len(sig) == 64 and _ED25519(pub, "\n".join(lines).encode(), sig)
    except Exception:
        ok = False
    return {"v": "verified" if ok else "invalid:bad signature", "bot": bot, "known": known}

def _nets(v):
    out = []
    for x in v.split(","):
        try:
            if x.strip():
                out.append(ipaddress.ip_network(x.strip(), strict=False))
        except ValueError:
            pass  # a bad entry is skipped, not fatal
    return out

_TRUSTED = _nets(os.environ.get("AIPAYGEN_TRUSTED_PROXIES", ""))

def _is_proxy(ip):
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(a.version == n.version and a in n for n in _TRUSTED)

def _client_ip(request):
    # X-Forwarded-For counts only when the request came from one of your proxies (AIPAYGEN_TRUSTED_PROXIES): then the
    # visitor is the last address in it that isn't one of them. Anyone can send the header, so otherwise it's ignored.
    remote = request.META.get("REMOTE_ADDR", "")
    if not _TRUSTED or not _is_proxy(remote):
        return remote
    for a in reversed([x.strip() for x in request.META.get("HTTP_X_FORWARDED_FOR", "").split(",") if x.strip()]):
        if not _is_proxy(a):
            return a
    return remote


class AIPayGenMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        from django.http import HttpResponse
        secret = os.environ.get("AIPAYGEN_SECRET", "")
        h = request.headers
        # This site's AI Terms (per-use terms for AI, aipaygen.com/ai-terms), served at /.well-known/ai-terms.
        if request.path == "/.well-known/ai-terms":
            # A crawler named in its user agent AND at an address its company publishes (the list the visits use) is
            # counted as a reader of the file, in memory, and sent with the next batch.
            named_t = AI_BOTS.search(h.get("user-agent", ""))
            if named_t and _ai_ip(_client_ip(request)):
                with _lock:
                    if named_t.group(0) in _state["terms"] or len(_state["terms"]) < 50:
                        _state["terms"][named_t.group(0)] = _state["terms"].get(named_t.group(0), 0) + 1
            try:
                resp = HttpResponse(_get(AIPAYGEN + "/v1/gateway/terms/" + ROUTE), content_type="application/json")
                resp["cache-control"] = "public, max-age=900"
                resp["access-control-allow-origin"] = "*"
                return resp
            except Exception:
                return self.get_response(request)
        # The gateway fetching a page it was paid for: serve it.
        if secret and h.get("x-aipaygen-gateway-secret") == secret:
            return self.get_response(request)
        # robots.txt is free for every crawler: it is how they learn your rules and find your terms.
        # Lines to add to it, written from your AI Terms (IETF aipref Content-Usage; training-only crawlers): https://aipaygen.com/v1/gateway/robots/YOUR_ROUTE_ID
        if request.path == "/robots.txt":
            return self.get_response(request)
        # A crawler retrying with a payment: AIPayGen verifies it, fetches the page and pays your wallet.
        if h.get("payment-signature") or h.get("x-payment"):
            fwd = {k: h[k] for k in ("payment-signature", "x-payment", "user-agent", "accept", "accept-language") if h.get(k)}
            try:
                with urllib.request.urlopen(urllib.request.Request(GATEWAY + request.get_full_path(), headers=fwd), timeout=30) as r:
                    status, body, headers = r.status, r.read(), r.headers
            except urllib.error.HTTPError as e:
                status, body, headers = e.code, e.read(), e.headers
            except Exception:
                return self.get_response(request)
            resp = HttpResponse(body, status=status)
            for k in ("content-type", "payment-required", "payment-response", "ai-purpose", "link", "content-usage", "x-aipaygen-charged", "x-aipaygen-delivery"):
                if headers.get(k):
                    resp[k] = headers[k]
            return resp
        if ASSET.search(request.path):
            return self.get_response(request)
        named = AI_BOTS.search(h.get("user-agent", ""))
        w = _wba(request)
        signed = w["known"] and w["v"] == "verified"
        forged = w["known"] and w["v"].startswith("invalid:")
        bot = w["bot"] if (signed or forged) else (named.group(0) if named else ("AI crawler (by IP)" if _ai_ip(_client_ip(request)) else None))
        if not bot:
            _send_report(secret)  # returns at once unless the daily "still installed" report is due
            return self.get_response(request)
        # Counted as "<name> (fake)": a name whose operator publishes its addresses (the quote's checked_bots), from
        # outside the address list this process has loaded. Never before the list has loaded; names with no published
        # list are never called fake. One list covers every operator, so a name used from another AI company's
        # addresses still counts as real: fakes can be under-counted, never over-counted.
        q = _quote()
        seen = bot + " (fake)" if forged else bot
        checked = (q or {}).get("checked_bots") if isinstance(q, dict) else None
        if not signed and not forged and named and isinstance(checked, list) and _state["nets"] and not _ai_ip(_client_ip(request)):
            seen = next((b + " (fake)" for b in checked if isinstance(b, str) and b.lower() == bot.lower()), bot)
        with _lock:
            _state["hits"][seen] = _state["hits"].get(seen, 0) + 1
            p = request.path[:200]
            if p in _state["paths"] or len(_state["paths"]) < 300:
                _state["paths"][p] = _state["paths"].get(p, 0) + 1
            _state["n"] += 1
        _send_report(secret)
        # Report-only, gateway unreachable, or a crawler this site lets in free: serve the page.
        if not q or q.get("charge_mode") == "off" or not q.get("accepts") or bot.lower() in [b.lower() for b in q.get("free_bots", [])]:
            return _sign(self.get_response(request), q)
        # Free allowance (AI Terms "free"): this many pages per UTC hour or day for each verified crawler,
        # one whose name AND address match the lists AI companies publish. Counted separately by each
        # worker process: a site running several can give up to that many times the allowance (never less).
        fa = q.get("free") or {}
        # A signed agent gets it only where the route turns that on (signed_free true in the quote; off otherwise).
        allowed = (not signed and not forged and named and _ai_ip(_client_ip(request))) or (signed and q.get("signed_free") is True)
        if allowed and isinstance(fa.get("requests"), int) and fa["requests"] > 0:
            win = time.strftime("%Y-%m-%dT%H" if fa.get("per") == "hour" else "%Y-%m-%d", time.gmtime())
            k = bot.lower()
            with _lock:
                if _state["free_win"] != win:
                    _state["free_win"], _state["free_used"] = win, {}
                used = _state["free_used"]
                if k in used or len(used) < 200:
                    used[k] = used.get(k, 0) + 1
                    if used[k] <= fa["requests"]:
                        return _sign(self.get_response(request), q)
        quote = {"x402Version": 2, "error": "PAYMENT_REQUIRED",
                 "resource": {"url": request.build_absolute_uri(), "description": q.get("description", ""), "mimeType": "text/html"},
                 "accepts": q["accepts"]}
        # The quote's x402 v2 extensions (AI Terms, ask before you buy), kept where the official SDK keeps them.
        if isinstance(q.get("extensions"), dict) and q["extensions"]:
            quote["extensions"] = q["extensions"]
        resp = HttpResponse(json.dumps(dict(quote, help=q.get("help"))), status=402, content_type="application/json")
        resp["payment-required"] = base64.b64encode(json.dumps(quote).encode()).decode()
        resp["cache-control"] = "no-store"
        return _sign(resp, q, page=False)
