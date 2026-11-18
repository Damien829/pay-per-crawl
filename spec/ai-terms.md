# AI Terms 0.1

**Status:** draft for comment, November 2026. Reference implementation: [AIPayGen](https://aipaygen.com/ai-terms). License: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

AI Terms is a file a website publishes at /.well-known/ai-terms that says, for each use of its content by AI (search, answer, training, agent), whether that use is allowed, allowed for a price, or not allowed. ([Plain definition](https://aipaygen.com/what-is-ai-terms).) It adds what robots.txt cannot express: the purpose of the access, a price and how to pay it, how identity is checked, and a receipt for every paid read.

## 1. Why

robots.txt (1994) answers one question: may this crawler name fetch this path? AI exposes four gaps:

1. **No uses.** A site can't say "AI search may read me, training may not", only per crawler name.
2. **No price.** The only choices are free or blocked.
3. **No identity.** Any client can send any crawler name.
4. **No record.** The site never learns what was taken or for what; the AI company can't prove what it licensed.

AI Terms fills those gaps and leaves robots.txt in place.

## 2. Location and discovery

- The file lives at `/.well-known/ai-terms` on the site's origin, served as `application/json` (UTF-8).
- A site MAY also point to it from any response with `Link: <url>; rel="ai-terms"`. Every HTTP 402 a site sends because of its terms MUST carry this link, and other responses to AI crawlers SHOULD, so a crawler or archive that keeps headers keeps the pointer. The URL may be off-site (for example a provider that generates terms from the site's settings).
- A site MAY add `AI-Terms: <url>` to robots.txt. RFC 9309 allows records beyond its own; crawlers that don't read this one are unaffected.
- A site SHOULD keep the terms file and `/robots.txt` free to fetch for every client, whatever its terms for other paths. They are how a client learns the rules and the price; a client that is refused `/robots.txt` may treat the site as having no rules at all (RFC 9309, section 2.3.1.3).

## 3. Uses

Every access by an AI system is one of four uses:

| Use | Meaning | Typical clients |
|---|---|---|
| `search` | Indexing pages to show links or snippets in AI search results | OAI-SearchBot, PerplexityBot, Claude-SearchBot |
| `answer` | Fetching a page live to answer a person's question right now | ChatGPT-User, Claude-User, Perplexity-User |
| `training` | Collecting pages to train or fine-tune models | GPTBot, ClaudeBot, CCBot, Bytespider |
| `agent` | An autonomous agent reading pages or calling endpoints to complete a task | Agent frameworks, browsing agents |

## 4. The file

```json
{
  "ai_terms": "0.1",
  "site": "https://example.com",
  "updated": "2026-11-16",
  "uses": {
    "search":   { "access": "allow", "attribution": "required" },
    "answer":   { "access": "allow", "attribution": "required" },
    "training": { "access": "paid", "price": { "amount": "0.002", "currency": "USD", "per": "page" } },
    "agent":    { "access": "paid", "price": { "amount": "0.002", "currency": "USD", "per": "page" } }
  },
  "default": "paid",
  "paths": [
    { "match": "/members/*", "uses": { "search": { "access": "deny" }, "answer": { "access": "deny" } } }
  ],
  "identity": { "verify": ["published-ip-ranges"], "unverified": "treated-as-unidentified" },
  "purpose_header": "AI-Purpose",
  "payment": { "protocol": "x402", "version": 2, "endpoint": "https://aipaygen.com/g/abc123def456", "network": "eip155:8453", "asset": "USDC" },
  "receipts": "x402 PAYMENT-RESPONSE header: the settled transaction, verifiable on-chain",
  "contact": { "licensing": "https://example.com/licensing" },
  "spec": "https://aipaygen.com/ai-terms"
}
```

| Field | Required | Meaning |
|---|---|---|
| `ai_terms` | yes | Version of this spec the file follows. |
| `site` | yes | The origin the terms apply to. |
| `updated` | yes | Date of the last change (YYYY-MM-DD). |
| `uses` | yes | Terms for each of the four uses (section 5). |
| `default` | yes | `allow`, `paid` or `deny` for an AI client that declares no use. |
| `paths` | no | Overrides for parts of the site (section 6). |
| `identity` | no | How the site checks who a client is (section 7). |
| `purpose_header` | no | Always `AI-Purpose` in 0.1 (section 8). |
| `payment` | when any use is `paid` | How to pay (section 9). |
| `receipts` | no | What the client receives as proof of a paid read (section 10). |
| `report_only` | no | `true` when the site is only measuring AI traffic and charges nobody yet. |
| `contact.licensing` | no | Where to arrange bulk or custom licenses. |
| `spec` | no | Link to this document. |

## 5. Access, price, attribution

- `access`: `allow` (free), `paid` (pay the price per unit) or `deny` (do not access for this use).
- `price`: `amount` as a decimal string, `currency` (`USD` in 0.1; settled in a USD stablecoin), `per` = `page` or `request`.
- `attribution`: `required` (cite and link the page when its content is shown), `requested`, or `none`.

- `free` (optional, on a `paid` or `deny` use): `{ "requests": 100, "per": "day" }`. A verified client (section 7) may make up to `requests` requests for that use in each UTC `hour` or `day` without paying or being refused; after that, the use's access applies. `requests` is a whole number from 1 to 1,000,000,000. An unverified client gets no allowance. Attribution still applies to free reads. On an `allow` use, `free` is ignored.

A client MUST NOT use content for a purpose whose access is `deny`, and MUST pay before using it for a purpose whose access is `paid`, beyond any free allowance.

The allowance is for pacing: a crawler that reads steadily can stay within it, and only a burst meets the terms. A site counts requests per client identity (operator) and per window. A site that counts approximately (several servers, each with its own count) MAY give more than the allowance, and SHOULD NOT give less.

## 6. Paths

`paths` is a list of `{ match, uses, payment? }`. `match` is a path glob where `*` matches zero or more characters except `/`; it must match the whole path, without the query. Path and pattern are compared normalized (RFC 3986 section 6.2.2): hex digits upper-case, encoded unreserved characters decoded, non-ASCII encoded as UTF-8; `%2F` is not a separator.

Each use is resolved on its own: among the entries that match the path and list that use, the one with the most literal (non-`*`) characters applies, and on a tie the first in the list. If none lists the use, the top-level `uses` applies, then `default`. Match in linear time (segment by segment); never with a backtracking regular expression.

## 7. Identity

`identity.verify` lists the methods the site uses to check a client's claimed identity:

- `published-ip-ranges`: the request's address must be in the operator's published list (OpenAI, Google, Perplexity, DuckDuckGo and Common Crawl publish them).
- `web-bot-auth`: the request carries an HTTP message signature from the operator's published key (IETF Web Bot Auth drafts).

A client whose claimed identity fails a listed check is treated as unidentified: the `default` terms apply, and the site MAY label it as fake in its records.

## 8. Declaring the purpose

A client SHOULD send `AI-Purpose: <use>` (one of `search`, `answer`, `training`, `agent`) with each request. By declaring a use, the client accepts that use's terms. The site MAY record the declaration and echo it back. Declaring one use and using the content for another is a breach of the terms.

## 9. Payment

When a use is `paid`, the site (or its payment endpoint) answers HTTP 402 with an x402 v2 quote for that request. `payment.endpoint` is an absolute `https` URL with no query or fragment: the content at path P is paid for at endpoint + P. A site that answers 402 itself MAY give its own origin. The client signs the payment and retries with the `PAYMENT-SIGNATURE` header; the content is returned only after the payment is verified. Settlement goes directly from the client's wallet to the site's wallet.

### 9.1 Describing a page before payment

A payment can't be taken back, so a client should know what it is buying, and a site should not be paid for something else.

- A quote (the 402) for a paid page SHOULD describe the page: its title, a short description or excerpt of its text, and its length. In x402 v2 this is the extension named `ai-terms` in the response's `extensions`: `{ "info": { "title", "description", "excerpt", "words", "delivery": "must-match" }, "schema": <JSON Schema for info> }`. `title` is at most 120 characters, `description` 300, `excerpt` 200 (each may be null); `words` is a whole number. A site's snippet opt-outs (`nosnippet`, `max-snippet`) apply to the text shown.
- A quote that describes a page commits to it: the commitment travels with the payment (in x402 v2, in the payment requirement's `extra`, which clients send back unchanged), so the delivery is checked against what that client was shown.
- A payment answering a described quote MUST NOT be settled unless the content delivered shares at least about half of its main text with the content that was described (main text: the page's main region when it marks one, otherwise its visible text). Precisely: the delivered main text is at least half as long as the described one, and the comparison rejects content that shares less than half of it.
- A description taken after the payment request is received MUST NOT be used to judge that payment: a site serving the same wrong content to everyone would match itself.
- A site or gateway that describes pages MUST NOT settle a page payment that carries no valid commitment, unless the quote it answers was not held to a description. It answers with a described quote instead.
- A quote's description is not itself authenticated. A client SHOULD send the quote's `ai-terms` extension back with its payment (x402 v2 clients do), and a payment that sends back `delivery: "must-match"` MUST NOT be settled unless it also carries a valid commitment. A page that is empty, much shorter, or mostly different text is not a delivery, whatever its HTTP status.
- The request made to describe a page and the request made to deliver it SHOULD be indistinguishable to the site.
- A quote is held to a description only if it carries one with `delivery: "must-match"`. Any other quote is not checked, and SHOULD say so: an `ai-terms` extension whose `info` is `{ "delivery": "not-checked", "described_quote": "<where to ask>" }`. A client that wants the check treats a quote with no `ai-terms` description as not checked, and asks for a described quote instead.

The terms file declares which applies: `"preview": { "shows": ["title", "description", "excerpt", "words"], "delivery": "must-match" | "per-quote" | "not-checked", "described_quote": "<where to ask>" }`. `described_quote` is an RFC 6570 URI Template with one variable, `path` (the page's path and query, starting with a slash), for example `https://pay.example/g/abc123def456{+path}`.

- `must-match`: every quote describes the page and is held to it.
- `per-quote`: each quote says which. Quotes from `described_quote` describe the page and are held to it; a quote marked `not-checked` is paid when the page loads.
- `not-checked`: pages are not described and deliveries are not compared.

This does not judge whether a page is good. It holds the site to the page it showed.

## 10. Receipts

A paid response carries the x402 `PAYMENT-RESPONSE` header (the settled transaction) and SHOULD echo `AI-Purpose`. Together with the URL and time, that is a **record of licensed use**: the site can show who read what, for which use, and what was paid; the AI company can show that it licensed the content it used.

## 11. Relation to existing work

- **robots.txt:** unchanged. A `Disallow` still means do not fetch. AI Terms adds uses, prices and receipts for what is fetched.
- **llms.txt:** a reading guide for AI; complementary.
- **RSL (Really Simple Licensing):** license terms; a site can point to them from `contact.licensing`.
- **IETF AI Preferences (draft-ietf-aipref-vocab, -attach):** AI Terms extends it; see section 16 for the mapping and how terms are written as `Content-Usage`.
- **ai.txt / ai.json (draft-car-ai-txt-wellknown):** declares usage policy and links to a pricing page (`Training-Fee`) but defines no payment, purpose declaration or identity check. The members here could also live as an ai.json extension.
- **Verifiable compliance records (draft-reilly-aipref-compliance):** signed records of what a processor did; explicitly excludes payment. A future signed receipt here may reuse its format.
- **Web Bot Auth (draft-ietf-webbotauth-httpsig-protocol):** an identity method in section 7.
- **x402:** the payment protocol in section 9.

## 12. Security and abuse

- Terms are a statement, not enforcement. Sites SHOULD enforce at the edge (402 for paid uses, verified identity for allowed ones); the reference implementation does.
- A client can lie about its name or purpose. Identity checks limit the first; receipts and copy detection make the second visible.
- Clients MUST cap what they pay per request and per day; a malicious file could set any price.
- A free allowance is counted per verified identity, so claiming a crawler's name does not earn its allowance.
- A commitment to a description MUST be integrity-protected with a key the site cannot get from the quote, bound to the request URL and short-lived.
- The delivery check compares text, not meaning, and does not cover a quote that carries no description.
- Off-site terms URLs MUST use HTTPS. Pay only at an endpoint named by terms from the site's own origin: anyone can publish terms naming a site and their own endpoint.
- robots.txt and `Content-Usage` written from terms MUST NOT be looser than the terms on any path (section 16).
- Values copied from a remote quote into headers MUST be checked against the header's syntax first.
- Bound the size of terms files you accept (for example 64 KiB) and the number of `paths` entries you consider.

## 13. Reference implementation

AIPayGen generates terms for every site from its settings (`/v1/gateway/terms/<route>`), publishes its own at <https://aipaygen.com/.well-known/ai-terms>, sends `Link: rel="ai-terms"` on its 402 answers, verifies identity against published IP ranges, settles with x402 and echoes `AI-Purpose` on paid reads. It writes terms as `Content-Usage` and robots.txt rules (section 16): robots.txt lines for any site at `/v1/gateway/robots/<route>`. Site snippets for WordPress, Cloudflare, Nginx, Apache, Caddy, Next.js, Netlify, Vercel, Express and Django are in this repository.

## 14. Tools for implementers

- **JSON Schema:** [`ai-terms.schema.json`](ai-terms.schema.json), also at <https://aipaygen.com/ai-terms/schema.json>.
- **Test vectors:** [`ai-terms-vectors.json`](ai-terms-vectors.json), also at <https://aipaygen.com/ai-terms/vectors.json>. `validate` cases say whether a file is valid; `resolve` cases say which access applies to a use on a path (section 6); `signals` cases check the `Content-Usage` value and robots.txt rules written from terms (section 16). A reader that agrees with every case reads terms the way the reference implementation does.
- **Validator:** <https://aipaygen.com/ai-terms#validate> checks a pasted file or the one a site serves. Programmatically: `POST https://aipaygen.com/ai-terms/validate` with the file as the body, or `{"url": "example.com"}`.
- **Python reader:** [`readers/python/ai_terms.py`](../readers/python/ai_terms.py): fetch, resolve, validate and derive `Content-Usage` in one standard-library file; passes every test vector except the robots.txt ones, which check a generator.
- **Generator:** <https://aipaygen.com/ai-terms#make> writes an allow/deny file for a static site, with the matching robots.txt lines and headers, no account needed.

## 15. Changes

- Clarification (2026-11-18): paths are resolved per use, ties go to the first entry, and `match` is matched against the percent-encoded path without the query (section 6). Every 402 sent because of the terms carries `Link: rel="ai-terms"` (section 2). `*` matches the empty string; paths and patterns are compared normalized; a use value that isn't an object with a valid `access` counts as not listed. `payment.endpoint` has no query or fragment (one new invalid vector). New section 16: how terms are written as IETF AI Preferences (`Content-Usage`) and robots.txt rules. Still `"ai_terms": "0.1"`; readers that followed the earlier wording another way may resolve some files differently.
- Clarification (2026-11-18): `payment.endpoint` is an absolute `https` URL (section 9). One published test vector used prose there and was corrected; files that already used a URL are unaffected. Still `"ai_terms": "0.1"`.

## 16. AI Terms as AI Preferences (aipref)

Each use refines one category of the IETF AI Preferences vocabulary (draft-ietf-aipref-vocab-08):

| AI Terms | aipref | Note |
|---|---|---|
| `training` | AI Training (`train-ai`) | AI Training is generative models only; `training` covers all models. |
| `answer`, `agent` | AI Use (`ai-use`) | A summary in AI search results is `answer`. |
| `search` | Search (`search`) | Search covers every search engine, not only AI search. |

The aipref statement for a path, from the access each use has there (section 6):

- `train-ai`: `y` if `training` is `allow`; `n` if `paid` or `deny`.
- `ai-use`: `y` if `answer` and `agent` are both `allow`; `n` if neither is; otherwise not stated.
- `search`: `y` if `search` and `training` are both `allow` (aipref Search also allows training inside search); otherwise not stated (a price or refusal for AI search is not a refusal of all search).

`paid` is `n` because a preference has no price: a reader that can't pay must not take the use free. A client that pays is licensed by its payment. A free allowance doesn't change the statement. Serialized as an RFC 9651 dictionary, for example `train-ai=n, search=y`.

- **Header:** send `Content-Usage: <statement>` on 200 responses (draft-ietf-aipref-attach), not on a 402 (it describes the message content, and a 402 carries the price; the Link is enough). Combine with a site's own as aipref does: `n` in either is `n`.
- **robots.txt:** add `Content-Usage` lines (site-wide, and one per `paths` entry) in every group, and a group for training-only crawlers (GPTBot, ClaudeBot, CCBot, Google-Extended, Applebot-Extended and others) with `Disallow` where `training` is `paid` or `deny`. A robots.txt `*` crosses `/` and the longest rule wins, so a rule can't always be exact: it MUST NOT be looser than the terms on any path it reaches, and errs stricter.
- **Reading both** (statements the site's origin attaches): the AI Terms access applies, except that an aipref `n` denies a use the terms `allow`, and an aipref `y` never opens a `paid` or `deny` use. An `n` where the terms say `paid` is the derived statement: a client that pays may still make the use. To refuse everyone, paying or not, say `deny` with no `free`.
- A `report_only` file states nothing.

Comments and pull requests welcome.
