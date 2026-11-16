# AI Terms 0.1

**Status:** draft for comment, November 2026. Reference implementation: [AIPayGen](https://aipaygen.com/ai-terms). License: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

AI Terms is one machine-readable file in which a website states, **per use**, what AI systems may do with its pages: read free, read for a price, or stay out. It adds what robots.txt cannot express: the purpose of the access, a price and how to pay it, how identity is checked, and a receipt for every paid read.

## 1. Why

robots.txt (1994) answers one question: may this crawler name fetch this path? AI exposes four gaps:

1. **No uses.** A site can't say "AI search may read me, training may not", only per crawler name.
2. **No price.** The only choices are free or blocked.
3. **No identity.** Any client can send any crawler name.
4. **No record.** The site never learns what was taken or for what; the AI company can't prove what it licensed.

AI Terms fills those gaps and leaves robots.txt in place.

## 2. Location and discovery

- The file lives at `/.well-known/ai-terms` on the site's origin, served as `application/json` (UTF-8).
- A site MAY also point to it from any response with `Link: <url>; rel="ai-terms"`, and SHOULD do so on HTTP 402 answers. The URL may be off-site (for example a provider that generates terms from the site's settings).
- A site MAY add `AI-Terms: <url>` to robots.txt. RFC 9309 allows records beyond its own; crawlers that don't read this one are unaffected.

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

A client MUST NOT use content for a purpose whose access is `deny`, and MUST pay before using it for a purpose whose access is `paid`.

## 6. Paths

`paths` is a list of `{ match, uses, payment? }`. `match` is a path glob where `*` matches any characters within one path segment. The most specific match wins (most literal characters); a matching entry's `uses` override the top-level ones for the listed uses only.

## 7. Identity

`identity.verify` lists the methods the site uses to check a client's claimed identity:

- `published-ip-ranges`: the request's address must be in the operator's published list (OpenAI, Google, Perplexity, DuckDuckGo and Common Crawl publish them).
- `web-bot-auth`: the request carries an HTTP message signature from the operator's published key (IETF Web Bot Auth drafts).

A client whose claimed identity fails a listed check is treated as unidentified: the `default` terms apply, and the site MAY label it as fake in its records.

## 8. Declaring the purpose

A client SHOULD send `AI-Purpose: <use>` (one of `search`, `answer`, `training`, `agent`) with each request. By declaring a use, the client accepts that use's terms. The site MAY record the declaration and echo it back. Declaring one use and using the content for another is a breach of the terms.

## 9. Payment

When a use is `paid`, the site (or its payment endpoint) answers HTTP 402 with an x402 v2 quote for that request. The client signs the payment and retries with the `PAYMENT-SIGNATURE` header; the content is returned only after the payment is verified. Settlement goes directly from the client's wallet to the site's wallet.

## 10. Receipts

A paid response carries the x402 `PAYMENT-RESPONSE` header (the settled transaction) and SHOULD echo `AI-Purpose`. Together with the URL and time, that is a **record of licensed use**: the site can show who read what, for which use, and what was paid; the AI company can show that it licensed the content it used.

## 11. Relation to existing work

- **robots.txt:** unchanged. A `Disallow` still means do not fetch. AI Terms adds uses, prices and receipts for what is fetched.
- **llms.txt:** a reading guide for AI; complementary.
- **RSL (Really Simple Licensing):** license terms; a site can point to them from `contact.licensing`.
- **IETF AI Preferences (draft-ietf-aipref-vocab, -attach):** its categories are AI Training, AI Use and Search. Here `search` = Search, `training` = AI Training, and `answer` and `agent` are two kinds of AI Use. Its `Content-Usage` header and robots.txt rule keep working; where either says no, that holds.
- **ai.txt / ai.json (draft-car-ai-txt-wellknown):** declares usage policy and links to a pricing page (`Training-Fee`) but defines no payment, purpose declaration or identity check. The members here could also live as an ai.json extension.
- **Verifiable compliance records (draft-reilly-aipref-compliance):** signed records of what a processor did; explicitly excludes payment. A future signed receipt here may reuse its format.
- **Web Bot Auth (draft-ietf-webbotauth-httpsig-protocol):** an identity method in section 7.
- **x402:** the payment protocol in section 9.

## 12. Security and abuse

- Terms are a statement, not enforcement. Sites SHOULD enforce at the edge (402 for paid uses, verified identity for allowed ones); the reference implementation does.
- A client can lie about its name or purpose. Identity checks limit the first; receipts and copy detection make the second visible.
- Clients MUST cap what they pay per request and per day; a malicious file could set any price.
- Off-site terms URLs MUST use HTTPS.

## 13. Reference implementation

AIPayGen generates terms for every site from its settings (`/v1/gateway/terms/<route>`), publishes its own at <https://aipaygen.com/.well-known/ai-terms>, sends `Link: rel="ai-terms"` on its 402 answers, verifies identity against published IP ranges, settles with x402 and echoes `AI-Purpose` on paid reads. Site snippets for WordPress, Cloudflare, Nginx, Apache, Next.js and Express are in this repository.

## 14. Tools for implementers

- **JSON Schema:** [`ai-terms.schema.json`](ai-terms.schema.json), also at <https://aipaygen.com/ai-terms/schema.json>.
- **Test vectors:** [`ai-terms-vectors.json`](ai-terms-vectors.json), also at <https://aipaygen.com/ai-terms/vectors.json>. `validate` cases say whether a file is valid; `resolve` cases say which access applies to a use on a path (section 6). A reader that agrees with every case reads terms the way the reference implementation does.
- **Validator:** <https://aipaygen.com/ai-terms#validate> checks a pasted file or the one a site serves. Programmatically: `POST https://aipaygen.com/ai-terms/validate` with the file as the body, or `{"url": "example.com"}`.
- **Generator:** <https://aipaygen.com/ai-terms#make> writes an allow/deny file for a static site, no account needed.

Comments and pull requests welcome.
