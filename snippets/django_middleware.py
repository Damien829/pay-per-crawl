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
_state = {"quote": None, "quote_at": 0.0, "nets": [], "nets_at": 0.0, "hits": {}, "paths": {}, "n": 0, "sent_at": time.time(), "sending": False}


def _get(url, timeout=3):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"user-agent": "aipaygen-django/1"}), timeout=timeout) as r:
        return r.read()


def _quote():
    if _state["quote"] is None or time.time() - _state["quote_at"] > 3600:
        _state["quote_at"] = time.time() - 3300  # if this fails, retry in 5 minutes
        try:
            _state["quote"] = json.loads(_get(AIPAYGEN + "/v1/gateway/quote/" + ROUTE))
            _state["quote_at"] = time.time()
        except Exception:
            pass
    return _state["quote"]


def _ai_ip(ip):
    # AI crawlers that hide their name, by the address ranges their companies publish (refreshed daily).
    if time.time() - _state["nets_at"] > 86400:
        _state["nets_at"] = time.time() - 86100
        try:
            nets = []
            for line in _get(AIPAYGEN + "/v1/ai_bot_ips?format=text").decode().split():
                try:
                    nets.append(ipaddress.ip_network(line.strip(), strict=False))
                except ValueError:
                    pass
            _state["nets"], _state["nets_at"] = nets, time.time()
        except Exception:
            pass
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(addr.version == n.version and addr in n for n in _state["nets"])


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
            for k in ("content-type", "payment-required", "payment-response", "ai-purpose", "link"):
                if headers.get(k):
                    resp[k] = headers[k]
            return resp
        if ASSET.search(request.path):
            return self.get_response(request)
        named = AI_BOTS.search(h.get("user-agent", ""))
        bot = named.group(0) if named else ("AI crawler (by IP)" if _ai_ip(_client_ip(request)) else None)
        if not bot:
            return self.get_response(request)
        with _lock:
            _state["hits"][bot] = _state["hits"].get(bot, 0) + 1
            p = request.path[:200]
            if p in _state["paths"] or len(_state["paths"]) < 300:
                _state["paths"][p] = _state["paths"].get(p, 0) + 1
            _state["n"] += 1
        q = _quote()
        _send_report(secret)
        # Report-only, gateway unreachable, or a crawler this site lets in free: serve the page.
        if not q or q.get("charge_mode") == "off" or not q.get("accepts") or bot.lower() in [b.lower() for b in q.get("free_bots", [])]:
            return self.get_response(request)
        quote = {"x402Version": 2, "error": "PAYMENT_REQUIRED",
                 "resource": {"url": request.build_absolute_uri(), "description": q.get("description", ""), "mimeType": "text/html"},
                 "accepts": q["accepts"]}
        resp = HttpResponse(json.dumps(dict(quote, help=q.get("help"))), status=402, content_type="application/json")
        resp["payment-required"] = base64.b64encode(json.dumps(quote).encode()).decode()
        resp["cache-control"] = "no-store"
        if q.get("terms"):
            resp["link"] = "<" + q["terms"] + '>; rel="ai-terms"'
        return resp
