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


GLOB_MAX_LEN, GLOB_MAX_STARS = 512, 16
_UNRESERVED = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
_PATH_CHARS = _UNRESERVED | set("!$&'()*+,;=:@/")
_HEX = "0123456789abcdefABCDEF"


def normalize_path(s):
    """A path or pattern in one comparable form (RFC 3986 section 6.2.2): hex digits upper-case, encoded
    unreserved characters decoded, anything outside the path set percent-encoded as UTF-8."""
    out, i = [], 0
    while i < len(s):
        c = s[i]
        if c == "%" and i + 2 < len(s) and s[i + 1] in _HEX and s[i + 2] in _HEX:
            ch = chr(int(s[i + 1:i + 3], 16))
            out.append(ch if ch in _UNRESERVED else "%" + s[i + 1:i + 3].upper())
            i += 3
            continue
        if c in _PATH_CHARS:
            out.append(c)
        else:
            out.extend("%%%02X" % b for b in c.encode("utf-8"))
        i += 1
    return "".join(out)


def _segment_match(pat, seg):
    pieces = pat.split("*")
    if len(pieces) == 1:
        return pat == seg
    first, last = pieces[0], pieces[-1]
    if len(first) + len(last) > len(seg) or not seg.startswith(first) or not seg.endswith(last):
        return False
    at, end = len(first), len(seg) - len(last)
    for piece in pieces[1:-1]:
        if not piece:
            continue
        found = seg.find(piece, at)
        if found < 0 or found + len(piece) > end:
            return False
        at = found + len(piece)
    return True


def _matches(pattern, path):
    # "*" matches any characters except "/"; the pattern must match the whole path. Linear: segment by segment,
    # leftmost placement of each piece (never a backtracking regular expression).
    if len(pattern) > GLOB_MAX_LEN or pattern.count("*") > GLOB_MAX_STARS:
        return False
    ps, ss = pattern.split("/"), path.split("/")
    return len(ps) == len(ss) and all(_segment_match(p, q) for p, q in zip(ps, ss))


def _usable(rule):
    return isinstance(rule, dict) and rule.get("access") in ("allow", "paid", "deny")


def resolve(terms, use, path="/"):
    """The terms that apply to one use on one path, as a dict with at least "access".

    Each use on its own: among the `paths` entries that match the path and list the use (as an object with a
    valid access), the one with the most literal characters wins, the first on a tie; else the top-level
    terms for the use; else `default`. Path and patterns are compared normalized (normalize_path). `path` is
    the request path as a server resolves it: dot-segments already removed, no query.
    """
    if use not in USES:
        raise ValueError("use must be one of %s" % ", ".join(USES))
    best, best_len, p0 = None, -1, normalize_path(path)
    paths = terms.get("paths")
    for entry in paths if isinstance(paths, list) else []:
        if not isinstance(entry, dict) or not isinstance(entry.get("match"), str) or not isinstance(entry.get("uses"), dict):
            continue
        rule = entry["uses"].get(use)
        if not _usable(rule):
            continue
        m = normalize_path(entry["match"])
        literal = len(m.replace("*", ""))
        if _matches(m, p0) and literal > best_len:
            best, best_len = rule, literal
    if best is not None:
        return best
    uses = terms.get("uses")
    rule = uses.get(use) if isinstance(uses, dict) else None
    if _usable(rule):
        return rule
    d = terms.get("default")
    return {"access": d if d in ("allow", "paid", "deny") else "allow"}


def content_usage(terms, path="/"):
    """The IETF aipref Content-Usage value these terms imply for a path, e.g. "train-ai=n", or "" for none.

    Mapping (draft-ovalles-ai-terms-03): train-ai is y when training is allowed, n when it is paid or denied;
    ai-use is y when answer and agent are both allowed, n when neither is, otherwise not stated; search is y
    when search and training are both allowed (aipref Search also allows training inside search), otherwise
    not stated. A report_only document states nothing.
    """
    if terms.get("report_only") is True:
        return ""
    allowed = lambda use: resolve(terms, use, path)["access"] == "allow"
    out = ["train-ai=" + ("y" if allowed("training") else "n")]
    answer, agent = allowed("answer"), allowed("agent")
    if answer and agent:
        out.append("ai-use=y")
    elif not answer and not agent:
        out.append("ai-use=n")
    if allowed("search") and allowed("training"):
        out.append("search=y")
    return ", ".join(out)


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
        elif parts.scheme not in ("https", "http"):
            errors.append('"site" must be a web origin, like "https://example.com".')
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
                errors.append('%s.free must be an object: {"requests": 100, "per": "day"}.' % where)
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
        elif not re.match(r'^https://[^\s<>"?#]+\Z', payment["endpoint"]) or not _valid_host(payment["endpoint"]):
            errors.append("%s.endpoint must be an https URL with no query or fragment: the content at path P is paid for at endpoint + P." % where)

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
    if "preview" in doc:
        pv = doc["preview"]
        if not isinstance(pv, dict):
            errors.append('"preview" must be an object.')
        else:
            if pv.get("delivery") not in ("must-match", "per-quote", "not-checked"):
                errors.append('"preview.delivery" must be "must-match", "per-quote" or "not-checked".')
            shows = pv.get("shows")
            if shows is not None and (not isinstance(shows, list) or any(v not in ("title", "description", "excerpt", "words") for v in shows)):
                errors.append('"preview.shows" must list "title", "description", "excerpt" and/or "words".')
    if "contact" in doc and not isinstance(doc["contact"], dict):
        errors.append('"contact" must be an object.')
    if "identity" in doc:
        ident = doc["identity"]
        if not isinstance(ident, dict):
            errors.append('"identity" must be an object.')
        else:
            v = ident.get("verify")
            if v is not None and (not isinstance(v, list) or any(not isinstance(x, str) for x in v)):
                errors.append('"identity.verify" must be a list of method names, like ["published-ip-ranges"].')
            if "unverified" in ident and ident["unverified"] not in ("treated-as-claimed", "treated-as-unidentified"):
                warnings.append('"identity.unverified" is not "treated-as-claimed" or "treated-as-unidentified".')
    return errors, warnings


def _valid_host(url):
    try:
        return bool(urlsplit(url).hostname)
    except ValueError:
        return False
