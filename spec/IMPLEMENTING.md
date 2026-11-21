# Implementing an AI Terms reader

AI Terms is a draft ([draft-ovalles-ai-terms](https://datatracker.ietf.org/doc/draft-ovalles-ai-terms/)), not a standard. A draft needs implementations its author didn't write, and today it has none: the two published readers listed in [IMPLEMENTATIONS.md](IMPLEMENTATIONS.md) are by the draft's author. This page is for anyone who wants to write one, in any language.

Section numbers are those of **draft -03** ("§") and of this repository's [ai-terms.md](ai-terms.md) ("spec §"). MUST and SHOULD are the draft's. Where the published readers go further than the draft requires, this page says so.

## 1. What a reader does

### Fetch (draft §3.1, §4, §11; spec §2, §12)

- The site-wide document is at `https://<origin>/.well-known/ai-terms`, as JSON (UTF-8).
- A response can also point to a document with `Link: <url>; rel="ai-terms"`. Rules for linked documents:
  - The target MUST be `https`, and every redirect followed while retrieving it MUST be `https`.
  - Only a final response's `Link` fields count. A link with an `anchor` parameter is ignored. If there is more than one `ai-terms` link, ignore them all.
  - A linked document applies to that request's target and replaces the site-wide one for it. If it can't be read or isn't valid, use the site-wide document.
- **Ignore a document whose `site` is not the origin** of the content you're deciding about (MUST).
- Bound the size you accept (SHOULD; the draft's example is 64 KiB).
- What the published readers do beyond this:
  - fetch `https` only;
  - follow **no** redirects at all, which meets the redirect rule simply;
  - read at most 100,000 bytes;
  - treat a document they can't read as no document.

### Validate (draft §3.2–§3.4; spec §4, §5)

- The required members are `ai_terms`, `site`, `updated`, `uses` and `default`.
- Each use is an object with `access` of `allow`, `paid` or `deny`. `paid` needs a `price`.
- `free` is allowed only on `paid` or `deny`.
- `payment` is required when any use is `paid`. `payment.endpoint` is an absolute `https` URL with no query or fragment.
- The `validate` vectors (section 2 below) cover the cases.

### Resolve a use on a path (draft §3.5; spec §6)

- Each use is resolved on its own.
- In `match`, `*` matches zero or more characters other than `/`. The pattern must match the **whole** path, without the query.
- Compare normalized paths (RFC 3986 §6.2.2):
  - upper-case hex digits;
  - decode encoded unreserved characters;
  - UTF-8-encode non-ASCII;
  - remove dot-segments from the request path.

  `%2F` is not a separator.
- Among the matching entries that list the use with a valid value, the one with the most non-`*` characters wins; on a tie, the first one. Otherwise use the top-level `uses`, then `default`.
- A use whose value isn't an object with a valid `access` counts as not listed.
- Match in **linear time** (MUST), for example segment by segment. Never use a backtracking regular expression. You MAY ignore patterns over 512 characters or with more than 16 `*`.

### Derive the AI Preferences statement (draft §5.1, §5.2; spec §16)

From the access each use has on the path:

- `train-ai` is `y` if `training` is `allow`, and `n` if it's `paid` or `deny`.
- `ai-use` is `y` if `answer` and `agent` are both `allow`, and `n` if neither is. Otherwise it isn't stated.
- `search` is `y` if `search` and `training` are both `allow`. Otherwise it isn't stated.

Write the statement as an RFC 9651 dictionary in that order, e.g. `train-ai=n, search=y`. It's sent as `Content-Usage` on 200 responses, never on a 402. A `report_only` document states nothing.

### As a client (draft §6, §8, §11; spec §8, §9, §12)

- Don't make a use whose access is `deny`. Pay before making a `paid` use, beyond any free allowance.
- **Cap what you pay** per request and per day: a document can name any price.
- Pay only at an endpoint named by the site's own document: anyone can publish terms naming someone else's site.
- SHOULD send `AI-Purpose: <use>`.

robots.txt generation (draft §5.3) is for sites and generators, not readers.

## 2. Running the test vectors

The file is [ai-terms-vectors.json](ai-terms-vectors.json), also served at <https://aipaygen.com/ai-terms/vectors.json>. It's one JSON object: `about`, `version` (`"0.1"`) and these groups:

<!-- vector-groups: checked by spec/check_implementing.py -->
| Group | JSON path | Cases | Each case has | A reader passes when |
|---|---|---|---|---|
| `validate` | `validate` | 26 | `name`, `doc`, `valid`, sometimes `error_contains` | it calls `doc` valid exactly when `valid` is true |
| `resolve` | `resolve.cases` | 24 | `name`, `use`, `path`, `access` | resolving `use` on `path` under `resolve.terms` gives `access` |
| `content_usage` | `signals.content_usage` | 8 | `name`, `path`, `value`, sometimes its own `terms` | the statement for `path` (under the case's `terms`, else `resolve.terms`) is exactly `value` (`""` = nothing stated) |
| `robots` | `signals.robots` | 5 | `name`, `terms`, `checks` (31 in all) | generators only: what an RFC 9309 reader concludes from your robots.txt matches each check |
<!-- /vector-groups -->

A reader that agrees with every `validate`, `resolve` and `content_usage` case passes **58 of 58**.

`error_contains` is the reference implementation's English error text. Use it as a hint, not a requirement: an independent reader's messages will differ. `resolve.terms` holds only `default`, `uses` and `paths`; it's a fragment, not a full document.

A runner, in pseudo-code:

```
v = parse_json(read("ai-terms-vectors.json"))
failed = 0
for c in v.validate:
    if is_valid(c.doc) != c.valid: fail(c)
for c in v.resolve.cases:
    if resolve(v.resolve.terms, c.use, c.path).access != c.access: fail(c)
for c in v.signals.content_usage:
    terms = c.terms if present else v.resolve.terms
    if content_usage(terms, c.path) != c.value: fail(c)
if generates_robots_txt:
    for c in v.signals.robots:
        txt = generate_robots(c.terms)
        for k in c.checks:
            if rfc9309_allows(txt, k.agent, k.path) != k.fetch: fail(c, k)
            if k.content_usage present and k.fetch and content_usage_line(txt, k.agent, k.path) != k.content_usage: fail(c, k)
total = len(v.validate) + len(v.resolve.cases) + len(v.signals.content_usage)
print(total - failed, "of", total, "vectors pass")
exit(failed > 0)
```

Working runners: [readers/python/test_vectors.py](../readers/python/test_vectors.py) and [readers/js/test/vectors.test.js](../readers/js/test/vectors.test.js).

## 3. Reporting your implementation

Open a pull request that adds one row to [IMPLEMENTATIONS.md](IMPLEMENTATIONS.md):

- **Name:** your implementation's name.
- **Language.**
- **Link:** a public source or package URL.
- **Vectors passed:** for example `58 of 58`, or `52 of 58 (validate 20/26)`.
- **What it does:** for example fetch, resolve, derive, generate robots.txt.
- **Independent:** `yes` only if neither the draft's author nor code from the reference implementation or the readers here went into it. Otherwise `no`, with the reason.

Rows are listed as reported, with the date. Listing isn't an endorsement, and a row claims nothing beyond what it says. If your results differ from a vector, say which case: a disagreement may be a bug in the vector or an unclear sentence in the draft, and both are worth fixing.
