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

    // Kasa (TP-Link) cloud proxy. The app sends { url, payload }; we forward
    // payload as a POST to the TP-Link cloud and return its JSON. The target
    // host is restricted to tplinkcloud.com so this can't be used as an open
    // proxy. No credentials are stored here — the app passes them per request
    // and only a short-lived token is kept client-side.
    if (url.pathname === '/kasa') {
      if (request.method !== 'POST') {
        return json({ error: 'Use POST for /kasa' }, 405);
      }
      try {
        const { url: target, payload } = await request.json();
        let host;
        try {
          host = new URL(target).host;
        } catch {
          return json({ error: 'Invalid target url' }, 400);
        }
        if (!/(^|\.)tplinkcloud\.com$/.test(host)) {
          return json({ error: 'Target host not allowed' }, 403);
        }
        const upstream = await fetch(target, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const text = await upstream.text();
        return new Response(text, {
          status: upstream.status,
          headers: { ...CORS, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // Read-only diagnostic: run the watchdog in dry-run mode using the stored
    // secrets, so login / device detection can be verified without switching
    // anything. Safe to call; never toggles an outlet.
    if (url.pathname === '/kasa-test') {
      const report = await kasaKeepOff(env, { dryRun: true });
      return json(report, 200);
    }

    return json({ status: 'ok' }, 200);
  },

  // Cron watchdog (see triggers.crons in wrangler.jsonc). Runs on Cloudflare's
  // schedule — no phone or browser needed — and forces any outlet whose Kasa
  // name matches KASA_KEEPOFF (default "skimmer") OFF whenever it is ON. This
  // catches equipment that would otherwise restart after a power outage.
  // Requires the KASA_EMAIL and KASA_PASSWORD secrets to be set on the Worker.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(kasaKeepOff(env));
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// POST a JSON payload to the TP-Link cloud and return the parsed response.
async function tplink(url, payload) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.json();
}

// Runs the watchdog. Returns a diagnostic report. When opts.dryRun is true it
// reports what it sees but never switches anything (used by /kasa-test).
async function kasaKeepOff(env, opts) {
  const dryRun = !!(opts && opts.dryRun);
  const report = { configured: false, login: false, deviceCount: 0, devices: [], guarded: [], turnedOff: [] };
  if (!env.KASA_EMAIL || !env.KASA_PASSWORD) { report.error = 'KASA_EMAIL / KASA_PASSWORD not set'; return report; }
  report.configured = true;
  const keep = String(env.KASA_KEEPOFF || 'skimmer')
    .toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  report.keepMatches = keep;

  // 1) Log in for a fresh token (re-login every run so token expiry is a non-issue).
  const login = await tplink('https://wap.tplinkcloud.com', {
    method: 'login',
    params: {
      appType: 'Kasa_Android',
      cloudUserName: env.KASA_EMAIL,
      cloudPassword: env.KASA_PASSWORD,
      terminalUUID: 'reeftrack-cron-watchdog',
    },
  });
  if (login.error_code !== 0 || !login.result || !login.result.token) {
    report.error = 'login failed: ' + (login.msg || ('error_code ' + login.error_code));
    return report;
  }
  report.login = true;
  const token = login.result.token;

  // 2) List devices.
  const list = await tplink('https://wap.tplinkcloud.com/?token=' + encodeURIComponent(token), {
    method: 'getDeviceList',
  });
  if (list.error_code !== 0 || !list.result) { report.error = 'getDeviceList failed'; return report; }
  const devs = list.result.deviceList || [];
  report.deviceCount = devs.length;

  // 3) For each online device, read outlets; force matching ones OFF (unless dry-run).
  for (const d of devs) {
    report.devices.push({ alias: d.alias, model: d.deviceModel, online: d.status === 1 });
    if (d.status !== 1) continue;
    const base = d.appServerUrl + '/?token=' + encodeURIComponent(token);
    const info = await tplink(base, {
      method: 'passthrough',
      params: { deviceId: d.deviceId, requestData: JSON.stringify({ system: { get_sysinfo: {} } }) },
    });
    if (info.error_code !== 0 || !info.result) continue;
    let sys;
    try { sys = JSON.parse(info.result.responseData).system.get_sysinfo; } catch (e) { continue; }
    const sysDevId = sys.deviceId || d.deviceId;
    const children = (sys.children && sys.children.length)
      ? sys.children
      : [{ id: '', alias: sys.alias, state: sys.relay_state }];
    for (const c of children) {
      const alias = String(c.alias || '').toLowerCase();
      if (!keep.some((k) => alias.includes(k))) continue;
      report.guarded.push({ alias: c.alias, on: c.state === 1 });
      if (c.state !== 1) continue;
      if (dryRun) { report.turnedOff.push(c.alias + ' (dry-run: would switch off)'); continue; }
      const childId = c.id ? (c.id.length <= 2 ? sysDevId + c.id : c.id) : '';
      const req = childId
        ? { context: { child_ids: [childId] }, system: { set_relay_state: { state: 0 } } }
        : { system: { set_relay_state: { state: 0 } } };
      await tplink(base, {
        method: 'passthrough',
        params: { deviceId: d.deviceId, requestData: JSON.stringify(req) },
      });
      report.turnedOff.push(c.alias);
    }
  }
  return report;
}

// redeploy nudge reeftrack-worker
