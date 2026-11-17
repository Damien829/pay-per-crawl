"""AI Terms 0.1 reader for Python. Standard library only, one file, no AIPayGen dependency.

AI Terms (https://aipaygen.com/ai-terms, draft-ovalles-ai-terms) is a JSON file at
/.well-known/ai-terms where a site says, per use, what AI may do with its pages:
allow, paid (with a price) or deny.

    import ai_terms

    terms = ai_terms.fetch("https://example.com")      # None if the site publishes none
    if terms:
        rule = ai_terms.resolve(terms, "agent", "/blog/post")
        if rule["access"] == "deny":
            ...  # do not use the page for this purpose
        elif rule["access"] == "paid":
            ...  # pay rule["price"] through terms["payment"] first (x402), within your own cap

    # Always tell the site what you are doing:
    headers = {"AI-Purpose": "agent"}

This file was written from the spec text and checked against the published test vectors
(run `python3 test_vectors.py`). License: MIT.
"""
import json
import re
import urllib.request
from datetime import date
from urllib.parse import urlsplit

VERSION = "0.1"
USES = ("search", "answer", "training", "agent")
ACCESS = ("allow", "paid", "deny")
MAX_BYTES = 100_000


def parse(text):
    """Returns the terms as a dict, or None when the text is not an AI Terms file."""
    try:
        doc = json.loads(text)
    except (ValueError, TypeError):
        return None
    if isinstance(doc, dict) and isinstance(doc.get("ai_terms"), str) and isinstance(doc.get("uses"), dict):
        return doc
    return None


def fetch(site, timeout=5.0, user_agent="ai-terms-python/0.1", purpose="agent"):
    """Reads a site's terms from /.well-known/ai-terms. Returns None when there are none.

    Only https is read, redirects are not followed off the file, and the body is capped.
    """
    parts = urlsplit(site if "://" in site else "https://" + site)
    if parts.scheme != "https" or not parts.netloc:
        return None
    req = urllib.request.Request(
        "https://%s/.well-known/ai-terms" % parts.netloc,
        headers={"User-Agent": user_agent, "Accept": "application/json", "AI-Purpose": purpose},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            if res.status != 200:
                return None
            return parse(res.read(MAX_BYTES).decode("utf-8", "replace"))
    except Exception:
        return None


def _matches(pattern, path):
    # "*" matches any characters within one path segment; the pattern must match the whole path.
    regex = "[^/]*".join(re.escape(piece) for piece in pattern.split("*"))
    return re.fullmatch(regex, path) is not None


def resolve(terms, use, path="/"):
    """The terms that apply to one use on one path, as a dict with at least "access".

    The top-level entry for the use applies unless a `paths` entry matches the path and lists
    that use; among matching entries the most specific wins (most literal characters).
    A use the file does not list falls back to `default`.
    """
    if use not in USES:
        raise ValueError("use must be one of %s" % ", ".join(USES))
    best, best_len = None, -1
    for entry in terms.get("paths") or []:
        if not isinstance(entry, dict) or not isinstance(entry.get("match"), str):
            continue
        rule = (entry.get("uses") or {}).get(use)
        if not isinstance(rule, dict):
            continue
        literal = len(entry["match"].replace("*", ""))
        if _matches(entry["match"], path) and literal > best_len:
            best, best_len = rule, literal
    if best is not None:
        return best
    rule = (terms.get("uses") or {}).get(use)
    if isinstance(rule, dict):
        return rule
    return {"access": terms.get("default", "allow")}


FREE_MAX_REQUESTS = 1000000000


def free_allowance(rule):
    """The free allowance on a paid or denied use, as (requests, "hour" | "day"), or None.

    A verified client may make that many requests for the use in each UTC hour or day before the
    use's access applies. Unverified clients get none. Attribution still applies to free reads.
    """
    free = rule.get("free") if isinstance(rule, dict) else None
    if not isinstance(free, dict) or rule.get("access") == "allow":
        return None
    n, per = free.get("requests"), free.get("per")
    if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= FREE_MAX_REQUESTS or per not in ("hour", "day"):
        return None
    return n, per


def allowed_within(rule, max_price_usd):
    """True when a client may proceed: access is allow, or paid at or under the client's cap.

    Clients MUST cap what they pay: a file can name any price.
    """
    if rule.get("access") == "allow":
        return True
    if rule.get("access") != "paid":
        return False
    try:
        return float(rule["price"]["amount"]) <= float(max_price_usd)
    except (KeyError, TypeError, ValueError):
        return False


def validate(doc):
    """Checks a parsed file against AI Terms 0.1. Returns (errors, warnings); valid when errors is empty."""
    errors, warnings = [], []
    if not isinstance(doc, dict):
        return ["The file must be a JSON object."], warnings

    if not isinstance(doc.get("ai_terms"), str):
        errors.append('"ai_terms" is required: the spec version, "0.1".')
    elif doc["ai_terms"] != VERSION:
        warnings.append('"ai_terms" is "%s"; this reader knows %s.' % (doc["ai_terms"], VERSION))

    site = doc.get("site")
    if not isinstance(site, str):
        errors.append('"site" is required: the origin the terms apply to.')
    else:
        parts = urlsplit(site)
        if not parts.scheme or not parts.netloc:
            errors.append('"site" must be a full URL, like "https://example.com".')
        elif parts.scheme != "https":
            warnings.append('"site" should be an https:// origin.')

    updated = doc.get("updated")
    ok_date = isinstance(updated, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", updated) is not None
    if ok_date:
        try:
            date.fromisoformat(updated)
        except ValueError:
            ok_date = False
    if not ok_date:
        errors.append('"updated" is required: the date of the last change, as YYYY-MM-DD.')

    if doc.get("default") not in ACCESS:
        errors.append('"default" is required: "allow", "paid" or "deny".')

    def check_use(rule, where):
        """Returns True when the use is paid."""
        if not isinstance(rule, dict):
            errors.append('%s must be an object with "access".' % where)
            return False
        if rule.get("access") not in ACCESS:
            errors.append('%s.access must be "allow", "paid" or "deny".' % where)
            return False
        if "attribution" in rule and rule["attribution"] not in ("required", "requested", "none"):
            errors.append('%s.attribution must be "required", "requested" or "none".' % where)
        if "free" in rule:
            free = rule["free"]
            if not isinstance(free, dict):
                errors.append('%s.free must be an object: {"requests": 1000, "per": "day"}.' % where)
            else:
                n = free.get("requests")
                if isinstance(n, bool) or not isinstance(n, int) or not 1 <= n <= FREE_MAX_REQUESTS:
                    errors.append("%s.free.requests must be a whole number from 1 to 1,000,000,000." % where)
                if free.get("per") not in ("hour", "day"):
                    errors.append('%s.free.per must be "hour" or "day".' % where)
                for k in free:
                    if k not in ("requests", "per"):
                        warnings.append("%s.free.%s is not part of 0.1; clients ignore it." % (where, k))
                if rule["access"] == "allow":
                    warnings.append('%s has a "free" allowance but its access is already "allow"; the allowance is ignored.' % where)
        if rule["access"] != "paid":
            if "price" in rule:
                warnings.append('%s has a "price" but is not paid; the price is ignored.' % where)
            return False
        price = rule.get("price")
        if not isinstance(price, dict):
            errors.append('%s is "paid" but has no "price".' % where)
            return True
        amount = price.get("amount")
        if not isinstance(amount, str) or re.fullmatch(r"\d+(\.\d+)?", amount) is None:
            errors.append('%s.price.amount must be a decimal string, like "0.002".' % where)
        elif float(amount) <= 0:
            errors.append("%s.price.amount must be more than 0." % where)
        if price.get("currency") != "USD":
            errors.append('%s.price.currency must be "USD" in 0.1.' % where)
        if price.get("per") not in ("page", "request"):
            errors.append('%s.price.per must be "page" or "request".' % where)
        return True

    def check_payment(payment, where):
        if not isinstance(payment, dict):
            errors.append("%s must be an object." % where)
            return
        if payment.get("protocol") != "x402":
            errors.append('%s.protocol must be "x402" in 0.1.' % where)
        if not isinstance(payment.get("endpoint"), str) or not payment["endpoint"]:
            errors.append("%s.endpoint is required: where a client pays." % where)

    top_paid = doc.get("default") == "paid"
    unpayable_path = False
    uses = doc.get("uses")
    if not isinstance(uses, dict):
        errors.append('"uses" is required: terms for search, answer, training and agent.')
    else:
        for use in USES:
            if use not in uses:
                errors.append('"uses.%s" is missing; all four uses are required.' % use)
            elif check_use(uses[use], "uses.%s" % use):
                top_paid = True
        for key in uses:
            if key not in USES:
                warnings.append('"uses.%s" is not one of the four uses; clients ignore it.' % key)

    paths = doc.get("paths")
    if paths is not None:
        if not isinstance(paths, list):
            errors.append('"paths" must be a list.')
        else:
            for i, entry in enumerate(paths):
                where = "paths[%d]" % i
                if not isinstance(entry, dict):
                    errors.append('%s must be an object with "match" and "uses".' % where)
                    continue
                if not isinstance(entry.get("match"), str) or not entry["match"].startswith("/"):
                    errors.append('%s.match must be a path that starts with "/".' % where)
                paid = False
                entry_uses = entry.get("uses")
                if not isinstance(entry_uses, dict) or not entry_uses:
                    errors.append("%s.uses must list at least one use." % where)
                else:
                    for key, rule in entry_uses.items():
                        if key not in USES:
                            warnings.append("%s.uses.%s is not one of the four uses." % (where, key))
                        elif check_use(rule, "%s.uses.%s" % (where, key)):
                            paid = True
                if "payment" in entry:
                    check_payment(entry["payment"], "%s.payment" % where)
                elif paid:
                    unpayable_path = True

    if "payment" in doc:
        check_payment(doc["payment"], "payment")
    elif top_paid or unpayable_path:
        errors.append('A use is "paid" but there is no "payment": a client has no way to pay.')
    if "purpose_header" in doc and doc["purpose_header"] != "AI-Purpose":
        errors.append('"purpose_header" must be "AI-Purpose" in 0.1.')
    return errors, warnings
