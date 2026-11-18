// Pay-per-crawl via AIPayGen, for Next.js 13 and newer.
// Save this file next to your app/ or pages/ folder (inside src/ if you use one), named:
//   middleware.js   on Next.js 13, 14 and 15
//   proxy.js        on Next.js 16 and newer
// Keep the .js ending even in a TypeScript project: it is plain JavaScript, so your type check skips it.
// Put AIPAYGEN_SECRET (your gateway secret) in the project's environment variables.
import { NextResponse } from "next/server";

const GATEWAY = "https://aipaygen.com/g/YOUR_ROUTE_ID";
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
const [AIPAYGEN, ROUTE] = GATEWAY.split("/g/");
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
  // Counted separately by each server process or serverless instance: a site running several can give up to
  // that many times the allowance (never less), because the counts are not shared between them.
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
      headers: { "content-type": "application/json", "cache-control": "no-store", "payment-required": btoa(ascii),
        // AI Terms: the route's machine-readable terms, which a 402 MUST link. (No Content-Usage here: it describes
        // the content of a message, and a 402 carries the price, not the page.)
        ...(aipaygenSignals().link ? { link: aipaygenSignals().link } : {}) },
    });
  } catch { return null; } // never let a quote problem break the page
}
// What the terms say, in headers crawlers already read: Link rel="ai-terms" and the IETF aipref Content-Usage
// (e.g. "train-ai=n"). The Link on the 402 and on pages served to AI crawlers; Content-Usage on those pages only.
// Nothing while report-only.
function aipaygenSignals() {
  const q = QUOTE, h = {};
  if (q && typeof q.terms === "string" && /^https:[^\s<>"]+$/.test(q.terms)) h.link = "<" + q.terms + '>; rel="ai-terms"';
  if (q && typeof q.content_usage === "string" && /^[a-z-]+=[yn](, [a-z-]+=[yn]){0,5}$/.test(q.content_usage)) h["content-usage"] = q.content_usage;
  return h;
}
// The site's own Content-Usage combined with ours as IETF aipref combines preferences: for each category, n in either
// is n. The site's other members are kept as they are; categories it doesn't state are added from ours.
function aipaygenMergeUsage(own, ours) {
  if (!own) return ours;
  const mine = {}, out = [];
  for (const p of ours.split(",")) { const kv = p.trim().split("="); mine[kv[0]] = kv[1]; }
  for (const p of String(own).split(",")) {
    const t = p.trim(), k = t.split(/[=;]/)[0];
    if (!t) continue;
    if (k in mine) { out.push(mine[k] === "n" ? k + "=n" : t); delete mine[k]; } else out.push(t);
  }
  for (const k in mine) out.push(k + "=" + mine[k]);
  return out.join(", ");
}
// The page as served, with those headers added (a Link the site already sends is kept, ours appended).
function aipaygenSign(res) {
  const h = aipaygenSignals();
  if (!res || !Object.keys(h).length) return res;
  try {
    const r = new Response(res.body, res);
    if (h.link && !/rel="?ai-terms/i.test(r.headers.get("link") || "")) r.headers.append("link", h.link);
    if (h["content-usage"]) r.headers.set("content-usage", aipaygenMergeUsage(r.headers.get("content-usage"), h["content-usage"]));
    return r;
  } catch { return res; }
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

export default async function aipaygen(req, ev) {
  const secret = process.env.AIPAYGEN_SECRET;
  if (secret && req.headers.get("x-aipaygen-gateway-secret") === secret) return NextResponse.next();
  if (req.nextUrl.pathname === "/.well-known/ai-terms") { const t = await aipaygenTerms(); if (t) return t; }
  // robots.txt is free for every crawler: it is how they learn your rules and find your terms.
  // Lines to add to it, written from your AI Terms (IETF aipref Content-Usage; training-only crawlers): https://aipaygen.com/v1/gateway/robots/YOUR_ROUTE_ID
  if (req.nextUrl.pathname === "/robots.txt") return NextResponse.next();
  // A crawler retrying with a payment: AIPayGen verifies it, fetches the page and settles to your wallet.
  if (req.headers.get("payment-signature") || req.headers.get("x-payment")) {
    return NextResponse.rewrite(new URL(GATEWAY + req.nextUrl.pathname + req.nextUrl.search));
  }
  const named = (req.headers.get("user-agent") || "").match(AI_BOTS);
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0];
  const bot = named ? named[0] : isAiIp(ip, (p) => ev.waitUntil(p)) ? "AI crawler (by IP)" : null;
  if (!bot) { // people and search engines browse free; very fast page-only readers are listed in your report
    const w = aipaygenWatch(ip, req.nextUrl.pathname, req.headers.get("user-agent"), secret);
    if (w) ev.waitUntil(w);
    return NextResponse.next();
  }
  const quote = await aipaygen402(req.url, bot, req.nextUrl.pathname, !!named && isAiIp(ip));
  ev.waitUntil(aipaygenReport(secret));
  // A crawler let in free still gets the terms Link and Content-Usage with the page.
  if (quote) return quote;
  const res = NextResponse.next();
  for (const [k, v] of Object.entries(aipaygenSignals())) res.headers.set(k, v);
  return res;
}

export const config = { matcher: "/((?!_next/|favicon.ico).*)" };
