# Pay-per-crawl: charge AI crawlers per page with HTTP 402

AI crawlers (GPTBot, ClaudeBot, PerplexityBot, CCBot, Bytespider and 20+ others) read your pages for free. Blocking them in `robots.txt` also keeps you out of AI answers. This repo gives you a third option: answer AI crawlers with **`402 Payment Required`** and a price, so the ones that pay get the page and you get paid in USDC, straight to your wallet. People and search engines (Googlebot, Bingbot) browse free.

It uses [x402](https://aipaygen.com/x402), the open protocol for paying over HTTP: the server quotes a price in a `payment-required` header, the client signs a USDC payment and retries, and it settles on Base in about a second.

**Live demo (on Vercel, not Cloudflare):** https://aipaygen-ppc-demo.vercel.app. Open it in a browser and you get the page; `curl -i -A GPTBot https://aipaygen-ppc-demo.vercel.app/` gets `402` with the price. Pay it with any x402 client and you get the page. How this compares to Cloudflare Pay Per Crawl: https://aipaygen.com/compare/cloudflare

**Not ready to charge? Start with the free report.** Sign up at https://aipaygen.com/pay-per-crawl#signup without a wallet ("None yet"), install the snippet or WordPress plugin, and every page is still served to everyone while you see which AI crawlers visit, which pages they take, and what they would have paid. Add a wallet later with one API call and charging turns on within the hour, no reinstall.

## How it works

1. A request from a known AI crawler (by user agent, or from the IP ranges OpenAI, Perplexity, DuckDuckGo and Common Crawl publish; list refreshed daily from https://aipaygen.com/v1/ai_bot_ips) gets `402 Payment Required` with your price, **answered by your own server** from a quote it fetches about once an hour. Unpaid crawler visits never leave your site.
2. A crawler that pays retries with an x402 payment header. That request goes to the AIPayGen gateway, which verifies the payment, fetches the page from your site with a secret header (which these snippets let through), settles the payment to your wallet and returns the page.
3. Everyone else is served by your site as usual. If your site errors, nobody is charged. If AIPayGen can't be reached, your pages are served as usual.
4. Visit counts (crawler name and the 10 most-requested paths, no visitor data) are sent in small batches, so you get a private **AI crawler report**: which bots visit, how often, and what they would have paid. The link is shown at signup and in the WordPress plugin's settings.
5. **Fast readers:** crawlers that don't say what they are and don't use published IP ranges still tend to give themselves away: a browser user agent asking for 60+ pages a minute without loading any images or stylesheets. The snippets (and WordPress, on sites with a persistent object cache) list those in your report as a network range (/24 or /48, never the full address) with the user agent. Report only: nothing is charged or blocked, so you can judge before acting.

Agents without a wallet can still pay through the gateway's `paid_fetch` tool. No fees to site owners; the gateway never holds your money. (Apache is the exception: its snippet sends unpaid crawlers to the gateway for the price, and doesn't report counts. Nginx answers locally but doesn't report counts either.)

## AI Terms (open draft)

[`spec/ai-terms.md`](spec/ai-terms.md) is an open format for telling AI what it may do with your pages **per use** (search, answer, training, agent: allow, paid or deny), with prices, identity checks, an `AI-Purpose` header and receipts for paid reads. Every pay-per-crawl route gets its terms generated from its settings at `https://aipaygen.com/v1/gateway/terms/<your-route-id>`. Readable version: https://aipaygen.com/ai-terms. Comments and pull requests welcome.

For implementers: a [JSON Schema](spec/ai-terms.schema.json), [test vectors](spec/ai-terms-vectors.json) for validation and path matching, a [validator](https://aipaygen.com/ai-terms#validate) and a no-account [file generator](https://aipaygen.com/ai-terms#make). The format is also an IETF Internet-Draft: [draft-ovalles-ai-terms](https://datatracker.ietf.org/doc/draft-ovalles-ai-terms/).

## Setup

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Damien829/pay-per-crawl/tree/main/cloudflare-worker)

1. Create a free route at **https://aipaygen.com/pay-per-crawl** (your site, a price per page, your wallet on Base). You get a route id and a gateway secret.
2. Install the piece for your platform:

| Platform | File |
|---|---|
| WordPress | [`wordpress/aipaygen-pay-per-crawl`](wordpress/aipaygen-pay-per-crawl) (zip the folder and upload it, or [download the zip](https://aipaygen.com/downloads/aipaygen-pay-per-crawl.zip)) |
| Cloudflare | One click: [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/Damien829/pay-per-crawl/tree/main/cloudflare-worker) ([`cloudflare-worker/`](cloudflare-worker)), or paste [`snippets/cloudflare-worker.js`](snippets/cloudflare-worker.js) |
| Nginx | Report (any mode): [`snippets/nginx-report.conf`](snippets/nginx-report.conf) + [`snippets/nginx-report.sh`](snippets/nginx-report.sh) from cron. Charging: [`snippets/nginx.conf`](snippets/nginx.conf) |
| Apache | [`snippets/apache.conf`](snippets/apache.conf) |
| Next.js / Vercel | [`snippets/nextjs-middleware.ts`](snippets/nextjs-middleware.ts) |
| Express / Node | [`snippets/express.js`](snippets/express.js) |
| Django / Python | [`snippets/django_middleware.py`](snippets/django_middleware.py) (stdlib only; set `AIPAYGEN_ROUTE` and `AIPAYGEN_SECRET`) |

On Cloudflare, the one-click Worker deploys in a minute; then set `AIPAYGEN_ROUTE` (your route id) and the secret `AIPAYGEN_SECRET` under Settings > Variables and Secrets if it did not ask for them, and add a route for your site (Workers > aipaygen-pay-per-crawl > Settings > Domains & Routes: `example.com/*`). For the snippets, replace `YOUR_ROUTE_ID` with your route id and set your gateway secret where the snippet says. Step-by-step guides: https://aipaygen.com/pay-per-crawl/setup/nginx (and `/wordpress`, `/cloudflare`, `/apache`, `/nextjs`, `/express`).

3. Check it:

```bash
curl -i -A GPTBot https://your-site.com/   # 402 with your price
curl -I https://your-site.com/             # 200 for everyone else
```

## Charge only training crawlers

Want AI search and assistants (OAI-SearchBot, ChatGPT-User, PerplexityBot, Claude-SearchBot...) to keep reading free so they can cite you, and charge only crawlers that collect training data? Pick that at signup, or switch any time:

```bash
curl -X PATCH https://aipaygen.com/v1/gateway/YOUR_ROUTE_ID \
  -H "authorization: Bearer YOUR_API_KEY" -H "content-type: application/json" \
  -d '{"charge_mode":"training"}'
```

The WordPress plugin and the Cloudflare, Next.js and Express snippets pick it up within an hour, with no reinstall. On Nginx and Apache, remove those names from the bot list in the config.

## Which AI crawlers are covered

GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-User, Claude-SearchBot, anthropic-ai, PerplexityBot, Perplexity-User, Google-Extended, GoogleOther, CCBot, Bytespider, Amazonbot, Applebot-Extended, meta-externalagent, FacebookBot, cohere-ai, Diffbot, YouBot, MistralAI-User, DuckAssistBot, PetalBot, Timpibot, ImagesiftBot, omgili, AI2Bot, ElevenlabsCrawler, ElevenlabsBot. What each one does: https://aipaygen.com/ai-crawlers

Which ones does your site block today? Free check: https://aipaygen.com/ai-crawlers · Data on 60 top sites: https://aipaygen.com/state-of-ai-crawlers

## Honest limits

- Crawlers from operators that publish no IP list (ClaudeBot, Bytespider and others) are recognized by name only, so one that pretends to be a browser gets the free page, same as with `robots.txt`. The Apache snippet matches by name only.
- Check any request yourself with the free `verify_bot` tool: `curl "https://aipaygen.com/v1/verify_bot?ip=1.2.3.4&user_agent=GPTBot"` says verified, fake, disguised or unverifiable.
- Most crawlers can't pay yet; today this works like a block with a price tag. x402 support in agent frameworks is growing.
- You need a wallet on Base to receive USDC.

## License

GPL-2.0-or-later for the WordPress plugin; MIT for the snippets.
