=== AIPayGen Pay-per-crawl ===
Contributors: aipaygen
Tags: ai crawlers, gptbot, robots, monetization, x402
Requires at least: 5.6
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 2.6.2
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

This plugin relies on the AIPayGen gateway, a third-party service at https://aipaygen.com. It contacts the gateway in exactly these five cases, and in no others:

1. **Price quote (about once an hour, or every 5 minutes while it can't get one):** downloads your route's price quote from https://aipaygen.com/v1/gateway/quote/<route>. With it, the plugin answers unpaid AI crawlers itself: an unpaid request is never sent to the gateway. The request names only your route id.
2. **Paid requests (only when a request carries an x402 payment header):** the plugin sends the requested path and query string, the crawler's user agent and accept headers, the payment header and your route id to https://aipaygen.com/g/<route>. The gateway verifies the payment, fetches the page from your site (with your gateway secret, so the plugin lets it through) and settles the payment to your wallet. If that succeeds, WordPress serves the page to the crawler as usual. If the payment is refused or the gateway answers with an error, the crawler gets a JSON answer (a new quote or an error) and not the page. If the gateway can't be reached, the page is served as usual.
3. **AI Terms (only when /.well-known/ai-terms is requested; a copy is kept 15 minutes, a failed download is retried after 5):** downloads your route's AI Terms from https://aipaygen.com/v1/gateway/terms/<route> and serves them at that address. The request names only your route id.
4. **AI crawler counts (once an hour):** sends the number of AI crawler visits by crawler name, how many times each verified crawler read your AI Terms file, and the 10 most-requested paths to https://aipaygen.com/v1/gateway/hits/<route>, with your gateway secret, so your report can show them. No visitor IP addresses, cookies or personal data are sent. With a persistent object cache only: when one address asks for 60 or more pages in a minute while sending a browser user agent, this report also includes its network range (the first three parts of the address, e.g. 203.0.113.0/24, never the full address), the user agent and the page rate. Nothing is charged or blocked; it is listed in your report for you to judge.
5. **Crawler address list (once a day, or after 15 minutes if the download failed):** downloads the published AI crawler IP ranges from https://aipaygen.com/v1/ai_bot_ips. Nothing about your visitors is sent.

Requests from people, search engines and logged-in users are never sent to the gateway. Calls 1, 3, 4 and 5 use the user agent "AIPayGen-WP/<version>" instead of WordPress's default, which would include your site's address; a paid request (2) carries the crawler's own user agent, as listed above.

Service terms: https://aipaygen.com/terms
Privacy policy: https://aipaygen.com/privacy

== Installation ==

1. Install and activate the plugin.
2. Create a free route for your site at https://aipaygen.com/pay-per-crawl: your site address and a price per page. Start with "None yet" to only see the report (no wallet needed), or add your wallet address on Base to charge.
3. In WordPress, go to Settings > AIPayGen pay-per-crawl and paste the route id and gateway secret. (A download from your sign-up page on https://aipaygen.com already has both: upload and activate, and they are filled in.)
4. Check it: in report-only mode your report shows AI crawler visits within about an hour. When charging, `curl -i -A GPTBot https://your-site.com/` should answer 402 with your price.

== Frequently Asked Questions ==

= Will this hurt my search ranking? =

No. Googlebot and Bingbot are not on the list of crawlers, so search engines see your site as before.

= Can crawlers actually pay? =

Clients that support x402 pay automatically. Agents without a wallet can buy your pages through AIPayGen's paid_fetch tool with prepaid credit; you get your full price either way.

= Which crawlers are charged? =

GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-User, Claude-SearchBot, PerplexityBot, Perplexity-User, CCBot, Bytespider, Amazonbot, meta-externalagent and other AI crawlers. The full list and what each one does: https://aipaygen.com/ai-crawlers

= What if a crawler pretends to be a browser? =

If it comes from an address its operator publishes (OpenAI, Anthropic, Perplexity, Mistral, DuckDuckGo, Common Crawl), it's charged anyway. Crawlers from operators that publish no address list (Bytespider, for example) are only caught by name, so one disguised as a browser gets the page free, the same as with robots.txt.

== Changelog ==

= 2.6.2 =
* Your report can show which verified AI crawlers read your AI Terms file: a crawler whose name and address both match what its company publishes is counted when it fetches /.well-known/ai-terms, and the count goes out with the hourly crawler counts (no new request).

= 2.6.1 =
* A paid page is now served by WordPress itself once the gateway confirms the payment; the plugin no longer prints the gateway's copy. Any other gateway answer, and your AI Terms, are decoded and printed as JSON only.
* The readme lists each of the five times the plugin contacts AIPayGen.
* Calls to AIPayGen use the user agent "AIPayGen-WP/<version>" instead of WordPress's default (which names your site).
* When no price quote can be had, the plugin waits 5 minutes before asking again instead of asking on every AI crawler visit.
* A relayed paid answer keeps the gateway's charge and delivery headers, and a paid page its Content-Usage and AI-Purpose headers.

= 2.6.0 =
* A crawler name used from outside its company's published addresses is counted as fake in your report (only for companies that publish their addresses).
* A paid retry the gateway answers with 402 keeps its link to your AI Terms.
* Serves your AI Terms at /.well-known/ai-terms, so AIPayGen confirms you control your site without a DNS record or file.

= 2.5.1 =
* The 402 answer links your route's AI Terms (Link: rel="ai-terms"), so a crawler can read the terms it is being asked to pay under.

= 2.5.0 =
* Personal download: the plugin file from your sign-up page on AIPayGen carries your route id and gateway secret, so install is upload and activate. The plugin copies them into its settings once and deletes that file. Without that file, the plugin works as before.

= 2.4.0 =
* Free allowance: when your route gives AI crawlers some free pages per hour or day (AI Terms "free"), each verified crawler (its name and its address both on the lists AI companies publish) reads that many free before the price applies.

= 2.3.1 =
* Settings page and install steps explain report-only mode. Only real user agents are matched (Google-Extended and Applebot-Extended are robots.txt tokens, not crawlers).

= 2.3.0 =
* Report-only mode: install without a wallet, see which AI crawlers visit and what they would have paid, and start charging later from the same route.

= 2.2.0 =
* Lists fast readers in your report: a browser user agent asking for 60+ pages a minute, often a crawler that hides its name. Report only, never charged. Needs a persistent object cache.

= 2.1.0 =
* Follows your route's bot rules: in "training" mode, AI search and assistant fetchers (OAI-SearchBot, ChatGPT-User, PerplexityBot...) read free and only training crawlers are charged.

= 2.0.0 =
* Unpaid AI crawlers get your price straight from your site; only paid requests go to AIPayGen. Faster for crawlers, and nothing depends on AIPayGen for ordinary visits.
* New: your AI crawler report (which bots, how often, top pages, what they would have paid). The private link is on the settings page.

= 1.3.0 =
* Charges ElevenLabs' crawlers too (ElevenlabsCrawler, which collects training data, and ElevenlabsBot).

= 1.2.0 =
* Catches AI crawlers that hide their name, using the IP ranges OpenAI, Perplexity, DuckDuckGo and Common Crawl publish (refreshed daily).

= 1.1.0 =
* WordPress.org release: prefixed settings, sanitized input, translations ready, uninstall cleanup, logged-in users always skipped.

= 1.0.0 =
* First release.
