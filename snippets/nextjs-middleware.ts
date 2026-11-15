// middleware.ts (Next.js 13+) - pay-per-crawl via AIPayGen.
// Put AIPAYGEN_SECRET (your gateway secret) in the project's environment variables.
import { NextResponse, type NextRequest } from "next/server";

const GATEWAY = "https://aipaygen.com/g/YOUR_ROUTE_ID";
const AI_BOTS = /GPTBot|OAI\-SearchBot|ChatGPT\-User|ClaudeBot|Claude\-User|Claude\-SearchBot|anthropic\-ai|PerplexityBot|Perplexity\-User|Google\-Extended|GoogleOther|CCBot|Bytespider|Amazonbot|Applebot\-Extended|meta\-externalagent|FacebookBot|cohere\-ai|Diffbot|YouBot|MistralAI\-User|DuckAssistBot|PetalBot|Timpibot|ImagesiftBot|omgili|AI2Bot/i;

export function middleware(req: NextRequest) {
  const secret = process.env.AIPAYGEN_SECRET;
  if (secret && req.headers.get("x-aipaygen-gateway-secret") === secret) return NextResponse.next();
  const paying = req.headers.get("payment-signature") || req.headers.get("x-payment");
  if (!AI_BOTS.test(req.headers.get("user-agent") || "") && !paying) return NextResponse.next(); // people browse free
  return NextResponse.rewrite(new URL(GATEWAY + req.nextUrl.pathname + req.nextUrl.search));
}

export const config = { matcher: "/((?!_next/|favicon.ico).*)" };
