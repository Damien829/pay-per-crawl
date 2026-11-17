"""Runs the published AI Terms test vectors against ai_terms.py.  python3 test_vectors.py"""
import json
import os
import sys

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

total = len(vectors["validate"]) + len(vectors["resolve"]["cases"])
print("%d of %d vectors pass" % (total - failed, total))
sys.exit(1 if failed else 0)
