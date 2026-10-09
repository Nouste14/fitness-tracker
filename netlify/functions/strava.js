// ═══════════════════════════════════════════════════════════════
//  Strava bridge for Nour Fitness
//
//  Why this exists: Strava's OAuth needs a client SECRET to refresh
//  tokens. A secret cannot live in a static page, so this function
//  holds it server-side. The browser only ever sees a refresh token
//  scoped to read your own activities.
//
//  SETUP (one time):
//   1. https://www.strava.com/settings/api -> create an app
//        Authorization Callback Domain:  <your-site>.netlify.app
//   2. Netlify -> Site settings -> Environment variables:
//        STRAVA_CLIENT_ID      = (from Strava)
//        STRAVA_CLIENT_SECRET  = (from Strava)
//   3. Redeploy. Then hit "Connect Strava" in the app.
// ═══════════════════════════════════════════════════════════════

const CID = process.env.STRAVA_CLIENT_ID;
const CS  = process.env.STRAVA_CLIENT_SECRET;

const json = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj)
});

exports.handler = async (event) => {
  const q      = event.queryStringParameters || {};
  const action = q.action || '';
  const proto  = (event.headers['x-forwarded-proto'] || 'https');
  const site   = process.env.URL || `${proto}://${event.headers.host}`;
  const cb     = `${site}/.netlify/functions/strava?action=callback`;

  if (!CID || !CS) {
    return json(500, { error: 'STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET not set in Netlify env vars' });
  }

  // ── 1. Kick off OAuth ──────────────────────────────────────────
  if (action === 'login') {
    const url = 'https://www.strava.com/oauth/authorize'
      + `?client_id=${encodeURIComponent(CID)}`
      + `&redirect_uri=${encodeURIComponent(cb)}`
      + '&response_type=code&approval_prompt=auto&scope=activity:read_all';
    return { statusCode: 302, headers: { Location: url } };
  }

  // ── 2. Strava redirects back here with ?code= ──────────────────
  if (action === 'callback') {
    if (q.error || !q.code) {
      return { statusCode: 302, headers: { Location: `${site}/?strava=denied` } };
    }
    try {
      const r = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: CID, client_secret: CS, code: q.code, grant_type: 'authorization_code' })
      });
      const t = await r.json();
      if (!t.refresh_token) return { statusCode: 302, headers: { Location: `${site}/?strava=error` } };
      // Hand the browser ONLY the refresh token. The secret never leaves here.
      const payload = Buffer.from(JSON.stringify({
        r: t.refresh_token,
        n: (t.athlete && t.athlete.firstname) || ''
      })).toString('base64');
      return { statusCode: 302, headers: { Location: `${site}/?strava=${encodeURIComponent(payload)}` } };
    } catch (e) {
      return { statusCode: 302, headers: { Location: `${site}/?strava=error` } };
    }
  }

  // ── 3. Refresh + pull activities ───────────────────────────────
  if (action === 'sync') {
    if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'bad json' }); }
    if (!body.refresh) return json(400, { error: 'no refresh token' });

    try {
      const tr = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: CID, client_secret: CS, refresh_token: body.refresh, grant_type: 'refresh_token' })
      });
      const t = await tr.json();
      if (!t.access_token) return json(401, { error: 'reconnect', detail: t.message || 'refresh rejected' });

      // default: last 120 days, enough to cover the whole race block
      const after = body.after || Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 120;
      const ar = await fetch(
        `https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=100`,
        { headers: { Authorization: 'Bearer ' + t.access_token } }
      );
      if (ar.status === 429) return json(429, { error: 'Strava rate limit — try again in 15 minutes' });
      const acts = await ar.json();
      if (!Array.isArray(acts)) return json(502, { error: 'unexpected response from Strava' });

      const runs = acts
        .filter(a => a.type === 'Run' || a.sport_type === 'Run' || a.sport_type === 'TrailRun')
        .map(a => ({
          sid:   a.id,
          name:  a.name || '',
          date:  (a.start_date_local || '').slice(0, 10),
          dist:  +((a.distance || 0) / 1000).toFixed(2),
          sec:   a.moving_time || a.elapsed_time || 0,
          hr:    a.average_heartrate ? Math.round(a.average_heartrate) : null,
          maxhr: a.max_heartrate ? Math.round(a.max_heartrate) : null,
          elev:  a.total_elevation_gain != null ? Math.round(a.total_elevation_gain) : null
        }))
        .filter(r => r.dist > 0 && r.sec > 0);

      // Strava rotates refresh tokens — hand the new one back so the
      // client can replace the stored value.
      return json(200, { refresh: t.refresh_token, runs, count: runs.length });
    } catch (e) {
      return json(500, { error: 'sync failed', detail: String(e && e.message || e) });
    }
  }

  return json(404, { error: 'unknown action' });
};
