# AI Terms reader for Python

One file, standard library only, no AIPayGen dependency. Copy `ai_terms.py` into your project.

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

Run `python3 test_vectors.py` to check it against the published [test vectors](../../spec/ai-terms-vectors.json): 25 of 25 pass.

This is a second implementation of the format, in a different language from the reference one (TypeScript, in the AIPayGen gateway). It has the same author, so it is not yet the independent implementation a standard needs. If you write one, open a pull request and it will be listed here.

License: MIT.
