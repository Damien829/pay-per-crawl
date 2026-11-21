# AI Terms reader for Python

One module, standard library only, no AIPayGen dependency, Python 3.8 or later. MIT. Copy `ai_terms.py` into your project.

[AI Terms](https://aipaygen.com/ai-terms) is a JSON file a site publishes at `/.well-known/ai-terms` that says, for each use of its content by AI (search, answer, training, agent), whether that use is allowed, allowed for a price, or not allowed. It is a draft ([draft-ovalles-ai-terms](https://datatracker.ietf.org/doc/draft-ovalles-ai-terms/)), not a standard.

```python
import ai_terms

terms = ai_terms.fetch("https://example.com")        # None when the site publishes no terms
if terms:
    rule = ai_terms.resolve(terms, "agent", "/blog/post")
    if not ai_terms.allowed_within(rule, max_price_usd=0.01):
        raise SystemExit("this site does not allow that use at my price")
# and declare what you are doing on every request:
headers = {"AI-Purpose": "agent"}
```

- `fetch(site)` reads `/.well-known/ai-terms` over https, capped at 100 KB.
- `resolve(terms, use, path)` returns the rule that applies (`access`, and `price` / `attribution` when set).
- `allowed_within(rule, max_price_usd)` is the check a careful client makes before reading or paying.
- `validate(doc)` returns `(errors, warnings)`.

From a checkout of the [repository](https://github.com/Damien829/pay-per-crawl), run `python3 readers/python/test_vectors.py` to check it against the published [test vectors](https://github.com/Damien829/pay-per-crawl/blob/main/spec/ai-terms-vectors.json): 58 of 58 pass.

This is a second implementation of the format, in a different language from the reference one (TypeScript, in the AIPayGen gateway). It has the same author, so it is not yet the independent implementation a standard needs. If you write one, open a pull request and it will be listed here.

License: MIT.
