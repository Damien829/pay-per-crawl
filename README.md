# Pay-per-crawl: charge AI crawlers per page with HTTP 402

AI crawlers (GPTBot, ClaudeBot, PerplexityBot, CCBot, Bytespider and 20+ others) read your pages for free. Blocking them in `robots.txt` also keeps you out of AI answers. This repo gives you a third option: answer AI crawlers with **`402 Payment Required`** and a price, so the ones that pay get the page and you get paid in USDC, straight to your wallet. People and search engines (Googlebot, Bingbot) browse free.

It uses [x402](https://aipaygen.com/x402), the open protocol for paying over HTTP: the server quotes a price in a `payment-required` header, the client signs a USDC payment and retries, and it settles on Base in about a second.

## How it works

1. A request from a known AI crawler (or one already carrying an x402 payment) is passed to the AIPayGen gateway on the same path.
2. Unpaid, the gateway answers `402` with your price and your wallet address.
3. Paid, the gateway verifies the payment, fetches the page from your site with a secret header (which these snippets let through), settles the payment to your wallet and returns the page.
4. Everyone else is served by your site as usual. If your site errors, nobody is charged. Agents without a wallet can still pay through the gateway's `paid_fetch` tool.

No fees to site owners; the gateway never holds your money.

## Setup

1. Create a free route at **https://aipaygen.com/pay-per-crawl** (your site, a price per page, your wallet on Base). You get a route id and a gateway secret.
2. Install the piece for your platform:

| Platform | File |
|---|---|
| WordPress | [`wordpress/aipaygen-pay-per-crawl`](wordpress/aipaygen-pay-per-crawl) (zip the folder and upload it, or [download the zip](https://aipaygen.com/downloads/aipaygen-pay-per-crawl.zip)) |
| Cloudflare | [`snippets/cloudflare-worker.js`](snippets/cloudflare-worker.js) |
| Nginx | [`snippets/nginx.conf`](snippets/nginx.conf) |
| Apache | [`snippets/apache.conf`](snippets/apache.conf) |
| Next.js / Vercel | [`snippets/nextjs-middleware.ts`](snippets/nextjs-middleware.ts) |
| Express / Node | [`snippets/express.js`](snippets/express.js) |

Replace `YOUR_ROUTE_ID` with your route id and set your gateway secret where the snippet says. Step-by-step guides: https://aipaygen.com/pay-per-crawl/setup/nginx (and `/wordpress`, `/cloudflare`, `/apache`, `/nextjs`, `/express`).

3. Check it:

```bash
curl -i -A GPTBot https://your-site.com/   # 402 with your price
curl -I https://your-site.com/             # 200 for everyone else
```

## Which AI crawlers are covered

GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-User, Claude-SearchBot, anthropic-ai, PerplexityBot, Perplexity-User, Google-Extended, GoogleOther, CCBot, Bytespider, Amazonbot, Applebot-Extended, meta-externalagent, FacebookBot, cohere-ai, Diffbot, YouBot, MistralAI-User, DuckAssistBot, PetalBot, Timpibot, ImagesiftBot, omgili, AI2Bot. What each one does: https://aipaygen.com/ai-crawlers

Which ones does your site block today? Free check: https://aipaygen.com/ai-crawlers · Data on 60 top sites: https://aipaygen.com/state-of-ai-crawlers

## Honest limits

- A crawler that pretends to be a browser gets the free page, same as with `robots.txt`.
- Most crawlers can't pay yet; today this works like a block with a price tag. x402 support in agent frameworks is growing.
- You need a wallet on Base to receive USDC.

## License

GPL-2.0-or-later for the WordPress plugin; MIT for the snippets.
