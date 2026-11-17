// Pay-per-crawl via AIPayGen, as a one-click Cloudflare Worker. Settings (Workers > this worker > Settings > Variables and Secrets):
//   AIPAYGEN_ROUTE   your route id from https://aipaygen.com/pay-per-crawl#signup
//   AIPAYGEN_SECRET  the gateway_secret you got with it (a secret, never shown again)
// Then add a route for your site (Workers > your worker > Settings > Domains & Routes: example.com/*).
let AIPAYGEN = "https://aipaygen.com", ROUTE = "", GATEWAY = ""; // set from env on the first request
const AI_BOTS = /GPTBot|OAI\-SearchBot|ChatGPT\-User|ClaudeBot|Claude\-User|Claude\-SearchBot|anthropic\-ai|PerplexityBot|Perplexity\-User|GoogleOther|CCBot|Bytespider|Amazonbot|meta\-externalagent|FacebookBot|cohere\-ai|Diffbot|YouBot|MistralAI\-User|DuckAssistBot|PetalBot|Timpibot|ImagesiftBot|omgili|AI2Bot|ElevenlabsCrawler|ElevenlabsBot/i;
// AI crawlers that hide their name are caught by address: the IP lists OpenAI, Anthropic, Perplexity,
// Mistral, DuckDuckGo and Common Crawl publish, collected daily at https://aipaygen.com/v1/ai_bot_ips
let AI_NETS = [], AI_NETS_AT = 0;
async function aiNetsLoad() {
  try {
    const r = await fetch("https://aipaygen.com/v1/ai_bot_ips?format=text", { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return;
    const nets = [];
    for (const c of (await r.text()).split("\n")) {
      const [a, n] = c.trim().split("/"), x = ipNum(a || "");
      if (!x) continue;
      const full = x[0] === 4 ? 32 : 128, len = n === undefined ? full : Number(n); // a bare address is one host
      if (!/^\d+$/.test(n === undefined ? "0" : n) || len > full) continue; // skip a bad line, keep the rest
      const s = BigInt(full - len);
      nets.push([x[0], s, x[1] >> s]);
    }
    if (nets.length) { AI_NETS = nets; AI_NETS_AT = Date.now(); }
  } catch {}
}
function ipNum(ip) {
  ip = ip.trim().replace(/^::ffff:(?=\d+\.)/i, "");
  if (ip.includes(".")) { const p = ip.split(".").map(Number); return p.length === 4 && p.every((x) => x >= 0 && x < 256) ? [4, p.reduce((a, x) => a * 256n + BigInt(x), 0n)] : null; }
  const [h, t] = ip.split("::"), H = h ? h.split(":") : [], T = t ? t.split(":") : [];
  const g = t === undefined ? H : [...H, ...Array(Math.max(0, 8 - H.length - T.length)).fill("0"), ...T];
  return g.length === 8 && g.every((x) => /^[0-9a-f]{1,4}$/i.test(x)) ? [6, g.reduce((a, x) => a * 65536n + BigInt(parseInt(x, 16)), 0n)] : null;
}
// Answers from the list in memory at once; a daily refresh runs in the background (wait keeps it alive on Workers).
function isAiIp(ip, wait) {
  if (Date.now() - AI_NETS_AT > 864e5) {
    AI_NETS_AT = Date.now() - 864e5 + 3e5; // one refresh at a time; if it fails, try again in 5 minutes
    const p = aiNetsLoad();
    if (wait) try { wait(p); } catch {}
  }
  const x = ip ? ipNum(ip) : null;
  return !!x && AI_NETS.some(([v, s, b]) => v === x[0] && x[1] >> s === b);
}
// Answer AI crawlers here with your price; only paid retries go to AIPayGen.
let QUOTE = null, QUOTE_AT = 0, HITS = {}, PAGES = {}, HIT_N = 0, SENT_AT = Date.now(), FAST = {}, FAST_N = 0, FREE_USED = {}, FREE_WIN = "";
// This site's AI Terms (what AI may do with its pages, per use; aipaygen.com/ai-terms), served at /.well-known/ai-terms.
async function aipaygenTerms() {
  try {
    const r = await fetch(AIPAYGEN + "/v1/gateway/terms/" + ROUTE, { signal: AbortSignal.timeout(3000) });
    if (r.ok) return new Response(await r.text(), { headers: { "content-type": "application/json", "cache-control": "public, max-age=900", "access-control-allow-origin": "*" } });
  } catch {}
  return null;
}
async function aipaygenQuote() {
  if (Date.now() - QUOTE_AT > 36e5) {
    // Set first: while AIPayGen can't be reached, one request tries again every 5 minutes and every
    // other crawler visit is served the page (or the last price) at once, without waiting on us.
    QUOTE_AT = Date.now() - 36e5 + 3e5;
    try {
      const r = await fetch(AIPAYGEN + "/v1/gateway/quote/" + ROUTE, { signal: AbortSignal.timeout(3000) });
      if (r.ok) { QUOTE = await r.json(); QUOTE_AT = Date.now(); }
    } catch {}
  }
  return QUOTE;
}
// verified: the crawler's name AND its address match the lists AI companies publish. Only verified
// crawlers get the site's free allowance (AI Terms "free"), so claiming a crawler's name earns nothing.
async function aipaygen402(url, bot, path, verified) {
  HITS[bot] = (HITS[bot] || 0) + 1; HIT_N++;
  if (PAGES[path] || Object.keys(PAGES).length < 300) PAGES[path] = (PAGES[path] || 0) + 1;
  const q = await aipaygenQuote();
  if (!q || q.charge_mode === "off") return null; // report only: count the visit, serve the page
  // Bots this site lets in free (its route's settings, e.g. AI search in "training" mode): serve the page.
  if ((q.free_bots || []).some((b) => b.toLowerCase() === String(bot).toLowerCase())) return null;
  // Free allowance: this many pages per UTC hour or day for each verified crawler, then the price.
  // Counted per process, so several servers may give a little more than the allowance, never less.
  const fa = q.free;
  if (verified && fa && fa.requests > 0) {
    const win = new Date().toISOString().slice(0, fa.per === "hour" ? 13 : 10);
    if (win !== FREE_WIN) { FREE_WIN = win; FREE_USED = {}; }
    const k = String(bot).toLowerCase();
    if (k in FREE_USED || Object.keys(FREE_USED).length < 200) {
      FREE_USED[k] = (FREE_USED[k] || 0) + 1;
      if (FREE_USED[k] <= fa.requests) return null;
    }
  }
  try {
    const quote = { x402Version: 2, error: "PAYMENT_REQUIRED", resource: { url, description: q.description, mimeType: "text/html" }, accepts: q.accepts };
    // The header is base64 of plain ASCII, so an accent, a dash or an emoji in a name can't break it.
    const ascii = JSON.stringify(quote).replace(/[^\x20-\x7e]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
    return new Response(JSON.stringify({ ...quote, help: q.help }), {
      status: 402,
      headers: { "content-type": "application/json", "cache-control": "no-store", "payment-required": btoa(ascii) },
    });
  } catch { return null; } // never let a quote problem break the page
}
// Visit counts for your AI crawler report, sent every few minutes in one small request.
async function aipaygenReport(secret) {
  const every = (QUOTE && QUOTE.report) || { every_seconds: 600, max_hits: 500 };
  if (!secret || !(HIT_N + FAST_N) || (HIT_N < every.max_hits && Date.now() - SENT_AT < every.every_seconds * 1000)) return;
  const pages = Object.fromEntries(Object.entries(PAGES).sort((a, b) => b[1] - a[1]).slice(0, 10));
  const fast = Object.fromEntries(Object.entries(FAST).sort((a, b) => b[1].times - a[1].times).slice(0, 20));
  const body = JSON.stringify(FAST_N ? { counts: HITS, paths: pages, fast } : { counts: HITS, paths: pages });
  HITS = {}; PAGES = {}; HIT_N = 0; SENT_AT = Date.now(); FAST = {}; FAST_N = 0;
  try {
    await fetch(AIPAYGEN + "/v1/gateway/hits/" + ROUTE, { method: "POST", headers: { "content-type": "application/json", "x-aipaygen-gateway-secret": secret }, body, signal: AbortSignal.timeout(5000) });
  } catch {}
}
// Fast readers: a browser user agent asking for many pages a minute and no images or stylesheets,
// the usual shape of a crawler in disguise. Only listed in your report (network /24 or /48 and user
// agent), never charged. Nothing is sent for normal visitors. The limit comes from the quote.
const SEEN = new Map(), ASSET = /\.(css|js|mjs|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|map)$/i;
function aipaygenNet(ip) {
  ip = String(ip || "").trim().replace(/^::ffff:(?=\d+\.)/i, "");
  if (/^(10|127)\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^(::1|f[cd]|fe80)/i.test(ip)) return null; // private: likely a proxy, not a visitor
  if (ip.includes(".")) { const p = ip.split("."); return p.length === 4 ? p.slice(0, 3).join(".") + ".0/24" : null; }
  const [h, t] = ip.split("::"), H = h ? h.split(":") : [], T = t ? t.split(":") : [];
  const g = t === undefined ? H : [...H, ...Array(Math.max(0, 8 - H.length - T.length)).fill("0"), ...T];
  return g.length === 8 && g.every((x) => /^[0-9a-f]{1,4}$/i.test(x)) ? g.slice(0, 3).map((x) => parseInt(x, 16).toString(16)).join(":") + "::/48" : null;
}
function aipaygenWatch(ip, path, ua, secret) {
  const net = aipaygenNet(ip), flush = () => (FAST_N ? aipaygenReport(secret) : undefined);
  if (!net) return flush();
  const now = Date.now(), lim = (QUOTE && QUOTE.fast) || { pages: 60, seconds: 60 };
  let s = SEEN.get(ip);
  if (!s || now - s[0] > lim.seconds * 1000) {
    if (SEEN.size >= 5000) SEEN.delete(SEEN.keys().next().value);
    s = [now, 0, 0]; SEEN.delete(ip); SEEN.set(ip, s);
  }
  if (ASSET.test(path)) { s[2]++; return flush(); }
  if (++s[1] < lim.pages || s[2]) return flush();
  const f = FAST[net] || (FAST[net] = { pages: 0, times: 0, ua: String(ua || "").slice(0, 160) });
  f.pages = Math.max(f.pages, s[1]);
  if (s[1] === lim.pages) { f.times++; FAST_N++; }
  return flush(); // sent with the next batch (every few minutes), never per visit
}
export default {
  async fetch(req, env, ctx) {
    if (!ROUTE && env.AIPAYGEN_ROUTE) { ROUTE = String(env.AIPAYGEN_ROUTE).trim().replace(/^.*\/g\//, ""); GATEWAY = AIPAYGEN + "/g/" + ROUTE; }
    if (!ROUTE) return fetch(req); // not set up yet: pass everything through
    // The gateway fetching a page it was paid for: serve it.
    if (env.AIPAYGEN_SECRET && req.headers.get("x-aipaygen-gateway-secret") === env.AIPAYGEN_SECRET) return fetch(req);
    const u = new URL(req.url);
    if (u.pathname === "/.well-known/ai-terms") { const t = await aipaygenTerms(); if (t) return t; }
    // robots.txt is free for every crawler: it is how they learn your rules and find your terms.
    if (u.pathname === "/robots.txt") return fetch(req);
    // A crawler retrying with a payment: AIPayGen verifies it, fetches the page and settles to your wallet.
    if (req.headers.get("payment-signature") || req.headers.get("x-payment")) {
      // Only what the gateway needs: never the visitor's cookies or authorization.
      const headers = {};
      for (const h of ["payment-signature", "x-payment", "user-agent", "accept", "accept-language"]) if (req.headers.get(h)) headers[h] = req.headers.get(h);
      // HEAD stays HEAD: the gateway answers a HEAD with the price and never settles it.
      return fetch(GATEWAY + u.pathname + u.search, { method: req.method === "HEAD" ? "HEAD" : "GET", headers, signal: AbortSignal.timeout(30000) })
        .catch(() => new Response('{"error":"PAYMENT_GATEWAY_UNAVAILABLE","message":"The payment service could not be reached. Nothing was charged. Try again shortly."}', { status: 503, headers: { "content-type": "application/json", "retry-after": "60", "cache-control": "no-store" } }));
    }
    const named = (req.headers.get("user-agent") || "").match(AI_BOTS);
    const ip = req.headers.get("cf-connecting-ip") || "";
    const bot = named ? named[0] : isAiIp(ip, (p) => ctx.waitUntil(p)) ? "AI crawler (by IP)" : null;
    if (!bot) { // people and search engines browse free; very fast page-only readers are listed in your report
      const w = aipaygenWatch(ip, u.pathname, req.headers.get("user-agent"), env.AIPAYGEN_SECRET);
      if (w) ctx.waitUntil(w);
      return fetch(req);
    }
    const quote = await aipaygen402(req.url, bot, u.pathname, !!named && isAiIp(ip));
    ctx.waitUntil(aipaygenReport(env.AIPAYGEN_SECRET));
    return quote || fetch(req);
  },
};
