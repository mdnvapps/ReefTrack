// ReefTrack code Worker
// Serves the /claude endpoint (proxies the Anthropic API using the CLAUDE_KEY
// secret) and passes every other request through to the static site assets.
// The API key lives ONLY in the Cloudflare "CLAUDE_KEY" secret — never in code.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);

    if (url.pathname === '/claude') {
      if (request.method !== 'POST') {
        return json({ error: 'Use POST for /claude' }, 405);
      }
      if (!env.CLAUDE_KEY) {
        return json({ error: 'CLAUDE_KEY secret is not set on this Worker' }, 500);
      }
      try {
        const body = await request.json();
        const upstream = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.CLAUDE_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
        });
        const text = await upstream.text();
        // Pass the upstream status through so real errors surface in the app.
        return new Response(text, {
          status: upstream.status,
          headers: { ...CORS, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // Everything else: serve the static site if assets are bound, else a health check.
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return json({ status: 'ok' }, 200);
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
