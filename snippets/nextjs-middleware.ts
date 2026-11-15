// middleware.ts (Next.js 13+) - pay-per-crawl via AIPayGen.
// Put AIPAYGEN_SECRET (your gateway secret) in the project's environment variables.
import { NextResponse, type NextRequest } from "next/server";

const GATEWAY = "https://aipaygen.com/g/YOUR_ROUTE_ID";
const AI_BOTS = /GPTBot|OAI\-SearchBot|ChatGPT\-User|ClaudeBot|Claude\-User|Claude\-SearchBot|anthropic\-ai|PerplexityBot|Perplexity\-User|Google\-Extended|GoogleOther|CCBot|Bytespider|Amazonbot|Applebot\-Extended|meta\-externalagent|FacebookBot|cohere\-ai|Diffbot|YouBot|MistralAI\-User|DuckAssistBot|PetalBot|Timpibot|ImagesiftBot|omgili|AI2Bot/i;

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

export async function middleware(req: NextRequest) {
  const secret = process.env.AIPAYGEN_SECRET;
  if (secret && req.headers.get("x-aipaygen-gateway-secret") === secret) return NextResponse.next();
  const paying = req.headers.get("payment-signature") || req.headers.get("x-payment");
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0];
  const bot = AI_BOTS.test(req.headers.get("user-agent") || "") || (await isAiIp(ip));
  if (!bot && !paying) return NextResponse.next(); // people browse free
  return NextResponse.rewrite(new URL(GATEWAY + req.nextUrl.pathname + req.nextUrl.search));
}

export const config = { matcher: "/((?!_next/|favicon.ico).*)" };
