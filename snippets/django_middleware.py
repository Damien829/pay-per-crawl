# aipaygen_middleware.py: pay-per-crawl for Django via AIPayGen (Python 3.8+, no extra packages).
# 1. Save this file next to settings.py.
# 2. Add "yourproject.aipaygen_middleware.AIPayGenMiddleware" near the top of MIDDLEWARE in settings.py.
# 3. Set AIPAYGEN_SECRET (the gateway secret you got at sign-up) in the environment and restart.
# People and search engines browse free. Report-only routes count AI crawlers and still serve the page.
import base64, ipaddress, json, os, re, threading, time, urllib.error, urllib.request

AIPAYGEN = "https://aipaygen.com"
ROUTE = os.environ.get("AIPAYGEN_ROUTE", "YOUR_ROUTE_ID")
GATEWAY = AIPAYGEN + "/g/" + ROUTE
AI_BOTS = re.compile("|".join(map(re.escape, ["GPTBot","OAI-SearchBot","ChatGPT-User","ClaudeBot","Claude-User","Claude-SearchBot","anthropic-ai","PerplexityBot","Perplexity-User","GoogleOther","CCBot","Bytespider","Amazonbot","meta-externalagent","FacebookBot","cohere-ai","Diffbot","YouBot","MistralAI-User","DuckAssistBot","PetalBot","Timpibot","ImagesiftBot","omgili","AI2Bot","ElevenlabsCrawler","ElevenlabsBot"])), re.I)
ASSET = re.compile("[.](css|js|mjs|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|map)$", re.I)

_lock = threading.Lock()
_state = {"quote": None, "quote_at": 0.0, "nets": {}, "nets_at": 0.0, "hits": {}, "paths": {}, "n": 0, "sent_at": time.time(), "sending": False, "free_used": {}, "free_win": ""}


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
    every = (_state["quote"] or {}).get("report") or {"every_seconds": 600, "max_hits": 500}
    with _lock:
        if _state["sending"] or not secret or not _state["n"]:
            return
        if _state["n"] < every.get("max_hits", 500) and time.time() - _state["sent_at"] < every.get("every_seconds", 600):
            return
        top = dict(sorted(_state["paths"].items(), key=lambda kv: -kv[1])[:10])
        body = json.dumps({"counts": _state["hits"], "paths": top}).encode()
        _state.update(hits={}, paths={}, n=0, sent_at=time.time(), sending=True)

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


def _client_ip(request):
    # Behind an AWS load balancer or another proxy, the visitor is the first X-Forwarded-For address.
    fwd = request.META.get("HTTP_X_FORWARDED_FOR", "")
    return fwd.split(",")[0].strip() if fwd else request.META.get("REMOTE_ADDR", "")


class AIPayGenMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        from django.http import HttpResponse
        secret = os.environ.get("AIPAYGEN_SECRET", "")
        h = request.headers
        # This site's AI Terms (per-use terms for AI, aipaygen.com/ai-terms), served at /.well-known/ai-terms.
        if request.path == "/.well-known/ai-terms":
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
        bot = named.group(0) if named else ("AI crawler (by IP)" if _ai_ip(_client_ip(request)) else None)
        if not bot:
            return self.get_response(request)
        # Counted as "<name> (fake)": a name whose operator publishes its addresses (the quote's checked_bots), from
        # outside the address list this process has loaded. Never before the list has loaded; names with no published
        # list are never called fake. One list covers every operator, so a name used from another AI company's
        # addresses still counts as real: fakes can be under-counted, never over-counted.
        q = _quote()
        seen = bot
        checked = (q or {}).get("checked_bots") if isinstance(q, dict) else None
        if named and isinstance(checked, list) and _state["nets"] and not _ai_ip(_client_ip(request)):
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
        if named and isinstance(fa.get("requests"), int) and fa["requests"] > 0 and _ai_ip(_client_ip(request)):
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
