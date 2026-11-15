=== AIPayGen Pay-per-crawl ===
Contributors: aipaygen
Tags: ai crawlers, gptbot, robots, monetization, x402
Requires at least: 5.6
Tested up to: 6.9
Requires PHP: 7.4
Stable tag: 1.2.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Charge AI crawlers like GPTBot and ClaudeBot per page with HTTP 402, paid in USDC straight to your wallet. People and search engines browse free.

== Description ==

AI crawlers (GPTBot, ClaudeBot, PerplexityBot, CCBot, Bytespider and others) read your pages for free. Blocking them in robots.txt also keeps you out of AI answers. This plugin gives you a third option: answer AI crawlers with **HTTP 402 Payment Required** and a price, so the ones that pay get the page and you get paid.

* Only known AI crawlers, and requests that already carry an x402 payment, are affected.
* Visitors, logged-in users, the admin area, cron, the REST API and search engines (Googlebot, Bingbot) are never affected.
* Payments go from the crawler's wallet directly to yours (USDC on Base). AIPayGen never holds them and charges site owners no fee.
* If the gateway can't be reached, your page is served as usual.

== Third-party service ==

This plugin relies on the AIPayGen gateway, a third-party service at https://aipaygen.com, to quote prices and verify and settle payments.

* **When it is used:** only for requests from known AI crawlers (by user agent, or by an address in the IP ranges AI crawler operators publish), or requests carrying an x402 payment header. Requests from people are never sent.
* **Crawler address list:** once a day the plugin downloads the published AI crawler IP ranges from https://aipaygen.com/v1/ai_bot_ips. Nothing about your site or visitors is sent with that request.
* **What is sent:** the requested path and query string, the crawler's user agent and accept headers, and any payment header, plus your route id.
* **What the gateway does:** answers unpaid requests with your price; for paid requests it verifies the payment, fetches the page from your site (with your gateway secret, so the plugin lets it through), settles the payment to your wallet, and returns the page to the crawler.

Service terms: https://aipaygen.com/terms
Privacy policy: https://aipaygen.com/privacy

== Installation ==

1. Install and activate the plugin.
2. Create a free route for your site at https://aipaygen.com/pay-per-crawl (your site address, a price per page and your wallet address on Base).
3. In WordPress, go to Settings > AIPayGen pay-per-crawl and paste the route id and gateway secret.
4. Check it: `curl -i -A GPTBot https://your-site.com/` should answer 402 with your price.

== Frequently Asked Questions ==

= Will this hurt my search ranking? =

No. Googlebot and Bingbot are not on the list of crawlers, so search engines see your site as before.

= Can crawlers actually pay? =

Clients that support x402 pay automatically. Agents without a wallet can buy your pages through AIPayGen's paid_fetch tool with prepaid credit; you get your full price either way.

= Which crawlers are charged? =

GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-User, Claude-SearchBot, PerplexityBot, Perplexity-User, CCBot, Bytespider, Amazonbot, meta-externalagent and other AI crawlers. The full list and what each one does: https://aipaygen.com/ai-crawlers

= What if a crawler pretends to be a browser? =

If it comes from an address its operator publishes (OpenAI, Perplexity, DuckDuckGo, Common Crawl), it's charged anyway. Crawlers from operators that publish no address list (ClaudeBot, Bytespider) are only caught by name, so one disguised as a browser gets the page free, the same as with robots.txt.

== Changelog ==

= 1.2.0 =
* Catches AI crawlers that hide their name, using the IP ranges OpenAI, Perplexity, DuckDuckGo and Common Crawl publish (refreshed daily).

= 1.1.0 =
* WordPress.org release: prefixed settings, sanitized input, translations ready, uninstall cleanup, logged-in users always skipped.

= 1.0.0 =
* First release.
