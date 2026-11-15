// Pay-per-crawl via AIPayGen. Set the secret: npx wrangler secret put AIPAYGEN_SECRET
const GATEWAY = "https://aipaygen.com/g/YOUR_ROUTE_ID";
const AI_BOTS = /GPTBot|OAI\-SearchBot|ChatGPT\-User|ClaudeBot|Claude\-User|Claude\-SearchBot|anthropic\-ai|PerplexityBot|Perplexity\-User|Google\-Extended|GoogleOther|CCBot|Bytespider|Amazonbot|Applebot\-Extended|meta\-externalagent|FacebookBot|cohere\-ai|Diffbot|YouBot|MistralAI\-User|DuckAssistBot|PetalBot|Timpibot|ImagesiftBot|omgili|AI2Bot|ElevenlabsCrawler|ElevenlabsBot/i;
// AI crawlers that hide their name are caught by address: the IP lists OpenAI, Perplexity,
// DuckDuckGo and Common Crawl publish, collected daily at https://aipaygen.com/v1/ai_bot_ips
let AI_NETS = [], AI_NETS_AT = 0;
function ipNum(ip) {
  ip = ip.trim().replace(/^::ffff:(?=\d+\.)/i, "");
  if (ip.includes(".")) { const p = ip.split(".").map(Number); return p.length === 4 && p.every((x) => x >= 0 && x < 256) ? [4, p.reduce((a, x) => a * 256n + BigInt(x), 0n)] : null; }
  const [h, t] = ip.split("::"), H = h ? h.split(":") : [], T = t ? t.split(":") : [];
  const g = t === undefined ? H : [...H, ...Array(Math.max(0, 8 - H.length - T.length)).fill("0"), ...T];
  return g.length === 8 && g.every((x) => /^[0-9a-f]{1,4}$/i.test(x)) ? [6, g.reduce((a, x) => a * 65536n + BigInt(parseInt(x, 16)), 0n)] : null;
}
async function isAiIp(ip) {
  if (Date.now() - AI_NETS_AT > 864e5) {
    AI_NETS_AT = Date.now() - 864e5 + 3e5; // if the fetch fails, try again in 5 minutes
    try {
      const r = await fetch("https://aipaygen.com/v1/ai_bot_ips?format=text", { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        AI_NETS = (await r.text()).split("\n").map((c) => { const [a, n] = c.split("/"), x = ipNum(a || ""); if (!x) return null; const s = BigInt((x[0] === 4 ? 32 : 128) - Number(n)); return [x[0], s, x[1] >> s]; }).filter(Boolean);
        AI_NETS_AT = Date.now();
      }
    } catch {}
  }
  const x = ip ? ipNum(ip) : null;
  return !!x && AI_NETS.some(([v, s, b]) => v === x[0] && x[1] >> s === b);
}
// Answer AI crawlers here with your price; only paid retries go to AIPayGen.
const [AIPAYGEN, ROUTE] = GATEWAY.split("/g/");
let QUOTE = null, QUOTE_AT = 0, HITS = {}, PAGES = {}, HIT_N = 0, SENT_AT = Date.now();
async function aipaygenQuote() {
  if (!QUOTE || Date.now() - QUOTE_AT > 36e5) {
    try {
      const r = await fetch(AIPAYGEN + "/v1/gateway/quote/" + ROUTE, { signal: AbortSignal.timeout(3000) });
      if (r.ok) { QUOTE = await r.json(); QUOTE_AT = Date.now(); }
    } catch {}
  }
  return QUOTE;
}
async function aipaygen402(url, bot, path) {
  HITS[bot] = (HITS[bot] || 0) + 1; HIT_N++;
  if (PAGES[path] || Object.keys(PAGES).length < 300) PAGES[path] = (PAGES[path] || 0) + 1;
  const q = await aipaygenQuote();
  if (!q) return null;
  // Bots this site lets in free (its route's settings, e.g. AI search in "training" mode): serve the page.
  if ((q.free_bots || []).some((b) => b.toLowerCase() === String(bot).toLowerCase())) return null;
  const quote = { x402Version: 2, error: "PAYMENT_REQUIRED", resource: { url, description: q.description, mimeType: "text/html" }, accepts: q.accepts };
  return new Response(JSON.stringify({ ...quote, help: q.help }), {
    status: 402,
    headers: { "content-type": "application/json", "cache-control": "no-store", "payment-required": btoa(JSON.stringify(quote)) },
  });
}
// Visit counts for your AI crawler report, sent every few minutes in one small request.
async function aipaygenReport(secret) {
  const every = (QUOTE && QUOTE.report) || { every_seconds: 600, max_hits: 500 };
  if (!secret || !HIT_N || (HIT_N < every.max_hits && Date.now() - SENT_AT < every.every_seconds * 1000)) return;
  const pages = Object.fromEntries(Object.entries(PAGES).sort((a, b) => b[1] - a[1]).slice(0, 10));
  const body = JSON.stringify({ counts: HITS, paths: pages });
  HITS = {}; PAGES = {}; HIT_N = 0; SENT_AT = Date.now();
  try {
    await fetch(AIPAYGEN + "/v1/gateway/hits/" + ROUTE, { method: "POST", headers: { "content-type": "application/json", "x-aipaygen-gateway-secret": secret }, body, signal: AbortSignal.timeout(5000) });
  } catch {}
}
export default {
  async fetch(req, env, ctx) {
    // The gateway fetching a page it was paid for: serve it.
    if (env.AIPAYGEN_SECRET && req.headers.get("x-aipaygen-gateway-secret") === env.AIPAYGEN_SECRET) return fetch(req);
    const u = new URL(req.url);
    // A crawler retrying with a payment: AIPayGen verifies it, fetches the page and settles to your wallet.
    if (req.headers.get("payment-signature") || req.headers.get("x-payment")) {
      return fetch(GATEWAY + u.pathname + u.search, { method: req.method, headers: req.headers, body: req.body });
    }
    const named = (req.headers.get("user-agent") || "").match(AI_BOTS);
    const bot = named ? named[0] : (await isAiIp(req.headers.get("cf-connecting-ip") || "")) ? "AI crawler (by IP)" : null;
    if (!bot) return fetch(req); // people and search engines browse free
    const quote = await aipaygen402(req.url, bot, u.pathname);
    ctx.waitUntil(aipaygenReport(env.AIPAYGEN_SECRET));
    return quote || fetch(req);
  },
};
