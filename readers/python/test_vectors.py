"""Runs the published AI Terms test vectors against ai_terms.py.  python3 test_vectors.py"""
import json
import os
import sys

import urllib.error

import ai_terms

here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, "..", "..", "spec", "ai-terms-vectors.json"), encoding="utf-8") as f:
    vectors = json.load(f)

failed = 0
for case in vectors["validate"]:
    errors, _ = ai_terms.validate(case["doc"])
    ok = (not errors) == case["valid"]
    if ok and case.get("error_contains"):
        ok = case["error_contains"] in " | ".join(errors)
    if not ok:
        failed += 1
        print("FAIL validate: %s -> %s" % (case["name"], errors))

terms = vectors["resolve"]["terms"]
for case in vectors["resolve"]["cases"]:
    got = ai_terms.resolve(terms, case["use"], case["path"])["access"]
    if got != case["access"]:
        failed += 1
        print("FAIL resolve: %s -> %s, expected %s" % (case["name"], got, case["access"]))

# aipref Content-Usage values (the "signals" cases; the robots.txt cases check a generator, which this reader is not).
for case in vectors["signals"]["content_usage"]:
    got = ai_terms.content_usage(case.get("terms", terms), case["path"])
    if got != case["value"]:
        failed += 1
        print("FAIL content_usage: %s -> %r, expected %r" % (case["name"], got, case["value"]))

# The reader's own helpers.
assert ai_terms.free_allowance({"access": "deny", "free": {"requests": 5, "per": "hour"}}) == (5, "hour")
assert ai_terms.free_allowance({"access": "allow", "free": {"requests": 5, "per": "hour"}}) is None
assert ai_terms.free_allowance({"access": "paid", "free": {"requests": True, "per": "day"}}) is None
assert ai_terms.parse("<html>") is None and ai_terms.parse('{"hello": 1}') is None
assert ai_terms.allowed_within({"access": "allow"}, 0) is True
assert ai_terms.allowed_within({"access": "deny"}, 100) is False
assert ai_terms.allowed_within({"access": "paid", "price": {"amount": "0.002"}}, 0.01) is True
assert ai_terms.allowed_within({"access": "paid", "price": {"amount": "5"}}, 0.01) is False
assert ai_terms.allowed_within({"access": "paid"}, 0.01) is False
assert ai_terms.fetch("http://example.com") is None  # https only
# No redirects: a 3xx is refused, not followed (urllib's default opener follows them, even from https to http).
# Checked on a loopback http server through the opener fetch() uses; no network.
import http.server, threading
class _Redirect(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        self.send_response(302); self.send_header("Location", "/elsewhere"); self.end_headers()
_srv = http.server.HTTPServer(("127.0.0.1", 0), _Redirect)
threading.Thread(target=_srv.serve_forever, daemon=True).start()
try:
    ai_terms._OPENER.open("http://127.0.0.1:%d/.well-known/ai-terms" % _srv.server_port, timeout=3)
    raise AssertionError("fetch's opener followed a redirect")
except urllib.error.HTTPError as e:
    assert e.code == 302
finally:
    _srv.shutdown()

assert ai_terms.content_usage({"default": "allow", "uses": {}}) == "train-ai=y, ai-use=y, search=y"
assert ai_terms.content_usage({"default": "deny", "uses": {"search": {"access": "paid"}}}) == "train-ai=n, ai-use=n"
# Linear matching: a hostile pattern answers at once (a backtracking regex took seconds).
import time
t0 = time.time(); assert not ai_terms._matches("/*a*a*a*a*a*a*b", "/" + "a" * 5000); assert time.time() - t0 < 0.5

total = len(vectors["validate"]) + len(vectors["resolve"]["cases"]) + len(vectors["signals"]["content_usage"])
print("%d of %d vectors pass" % (total - failed, total))
sys.exit(1 if failed else 0)
