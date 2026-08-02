// ReefTrack AI proxy — pure code Worker.
// POST /claude proxies to the Anthropic Messages API using the CLAUDE_KEY
// secret (the key stays in Cloudflare secrets, never in code). Every other
// path returns a simple health check. The app UI is served by GitHub Pages,
// so this Worker does not serve any static assets.

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

    return json({ status: 'ok' }, 200);
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
