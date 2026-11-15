// Pay-per-crawl via AIPayGen. Set the secret: npx wrangler secret put AIPAYGEN_SECRET
const GATEWAY = "https://aipaygen.com/g/YOUR_ROUTE_ID";
const AI_BOTS = /GPTBot|OAI\-SearchBot|ChatGPT\-User|ClaudeBot|Claude\-User|Claude\-SearchBot|anthropic\-ai|PerplexityBot|Perplexity\-User|Google\-Extended|GoogleOther|CCBot|Bytespider|Amazonbot|Applebot\-Extended|meta\-externalagent|FacebookBot|cohere\-ai|Diffbot|YouBot|MistralAI\-User|DuckAssistBot|PetalBot|Timpibot|ImagesiftBot|omgili|AI2Bot/i;
export default {
  async fetch(req, env) {
    // The gateway fetching a page it was paid for: serve it.
    if (env.AIPAYGEN_SECRET && req.headers.get("x-aipaygen-gateway-secret") === env.AIPAYGEN_SECRET) return fetch(req);
    const paying = req.headers.get("payment-signature") || req.headers.get("x-payment");
    if (!AI_BOTS.test(req.headers.get("user-agent") || "") && !paying) return fetch(req); // people browse free
    const u = new URL(req.url);
    return fetch(GATEWAY + u.pathname + u.search, { method: req.method, headers: req.headers, body: req.body });
  },
};
