# ai-terms: AI Terms reader for JavaScript and TypeScript

No dependencies. Runs in Node 18+, Deno, Bun, browsers and edge runtimes. MIT.

[AI Terms](https://aipaygen.com/ai-terms) is a JSON file a site publishes at `/.well-known/ai-terms` that says, for each use of its content by AI (search, answer, training, agent), whether that use is allowed, allowed for a price, or not allowed. It is a draft ([draft-ovalles-ai-terms](https://datatracker.ietf.org/doc/draft-ovalles-ai-terms/)), not a standard.

```js
import { fetchTerms, resolve, allowedWithin } from "ai-terms";

const terms = await fetchTerms("https://example.com");   // null when the site publishes none
if (terms) {
  const rule = resolve(terms, "agent", "/blog/post");
  if (!allowedWithin(rule, 0.01)) throw new Error("this site does not allow that use at my price");
}
// and declare what you are doing on every request:
const headers = { "AI-Purpose": "agent" };
```

- `fetchTerms(site, { timeoutMs, userAgent, purpose, fetch })` reads `https://<host>/.well-known/ai-terms`: https only, redirects not followed, at most 100 KB. Returns `null` when there are no terms or they can't be read.
- `resolve(terms, use, path)` returns the rule that applies (`access`, and `price` / `attribution` / `free` when set).
- `allowedWithin(rule, maxPriceUsd)` is the check a careful client makes before reading or paying.
- `freeAllowance(rule)` returns `{ requests, per }` for a paid or denied use with a free allowance, or `null`.
- `contentUsage(terms, path)` gives the IETF AI Preferences value the terms imply, e.g. `"train-ai=n, ai-use=y"`.
- `validate(doc, { origin })` returns `{ valid, errors, warnings }`.
- `parse(text)`, `termsLink(linkHeader)`, `globMatch`, `normalizePath` are exported too.

`npm test` builds the package and runs it against the published [test vectors](../../spec/ai-terms-vectors.json): 58 of 58 pass.

This is the matching, resolution, validation and AI Preferences code of the reference implementation (TypeScript, in the AIPayGen gateway), published as a library. It has the same author as the reference and the [Python reader](../python), so it is not an independent implementation. If you write one, open a pull request and it will be listed here.
