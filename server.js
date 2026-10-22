'use strict';

const http   = require('http');
const crypto = require('crypto');

// ==================== CONFIG ====================
const SECRET_KEY = process.env.SECRET_KEY;
const PORT       = parseInt(process.env.PORT || '3000', 10);
const HOST       = '0.0.0.0';
const ROUTE      = process.env.ROUTE || '/api';
const MAX_SKEW   = 300;

if (!SECRET_KEY) {
  console.error('[fatal] Missing env SECRET_KEY');
  process.exit(1);
}

const WEBHOOKS = {
  SecretHint:              process.env.WEBHOOK_SECRETHINT,
  Boss:                    process.env.WEBHOOK_BOSS,
  Item:                    process.env.WEBHOOK_ITEM,
  Island:                  process.env.WEBHOOK_ISLAND,
  Sword:                   process.env.WEBHOOK_SWORD,
  Fruit:                   process.env.WEBHOOK_FRUIT,
  Berries:                 process.env.WEBHOOK_BERRIES,
  Color:                   process.env.WEBHOOK_COLOR,
  'Event:Server 4 Hours':  process.env.WEBHOOK_EVENT_SERVER_4H,
  'Event:Pirate Raid':     process.env.WEBHOOK_EVENT_PIRATE_RAID,
  'Event:Full Moon 5/5':   process.env.WEBHOOK_EVENT_FULL_MOON,
  'Event:Near Full Moon':  process.env.WEBHOOK_EVENT_NEAR_FULL_MOON,
  Event:                   process.env.WEBHOOK_EVENT,
  Deleted:                 process.env.WEBHOOK_DELETED,
};
const FALLBACK = process.env.WEBHOOK_FALLBACK;

const SEA = {
  2753915549:      'Sea 1',
  85211729168715:  'Sea 1',
  4442272183:      'Sea 2',
  79091703265657:  'Sea 2',
  7449423635:      'Sea 3',
  100117331123089: 'Sea 3',
};

const COLORS = {
  SecretHint: 0x9b59b6,
  Boss:       0xe74c3c,
  Item:       0xf1c40f,
  Island:     0x2ecc71,
  Sword:      0x3498db,
  Fruit:      0xe67e22,
  Berries:    0x1abc9c,
  Color:      0x00bcd4,
  Event:      0x8e44ad,
};

// ==================== HELPERS ====================
function canonicalField(v) {
  const s = String(v ?? '');
  return Buffer.byteLength(s, 'utf8') + ':' + s;
}

function b64url(buf) {
  return buf.toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
}

function safeEqual(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readBody(req) {
  return new Promise((res, rej) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => res(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rej);
  });
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ==================== EMBED ====================
function buildEmbed(p, routeKey) {
  const isDel      = !!p.deleted;
  const sea        = SEA[Number(p.placeId)] || 'Unknown';
  const jobId      = String(p.jobId ?? '');
  const jobEncoded = jobId ? Buffer.from(jobId).toString('base64url') : '—';
  const ts         = Number(p.timestamp) || Math.floor(Date.now() / 1000);

  const fields = [
    { name: '🌊 Sea',     value: sea,                       inline: true  },
    { name: '👥 Players', value: String(p.players ?? '?'),  inline: true  },
    { name: '🏷️ PlaceId', value: String(p.placeId ?? '?'),  inline: true  },
    { name: '🔐 JobId',   value: '`' + jobEncoded + '`',    inline: false },
  ];

  if (p.hint   != null) fields.push({ name: 'Hint',   value: String(p.hint),   inline: false });
  if (p.island != null) fields.push({ name: 'Island', value: String(p.island), inline: false });

  const isFullMoon = p.name === 'Full Moon 5/5';
  const prefix     = isDel ? '❌ Mất' : (isFullMoon ? '🌕 FULL MOON' : '✅ Có');

  return {
    title:     `${prefix}: ${p.name}`,
    color:     isDel ? 0x7f8c8d : (COLORS[p.type] ?? 0x5865f2),
    fields,
    timestamp: new Date(ts * 1000).toISOString(),
    footer:    { text: `${sea} · ${p.type}` },
  };
}

// ==================== DISCORD ====================
async function postWebhook(url, body, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url + '?wait=true', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      if (r.status === 429) {
        const j = await r.json().catch(() => ({}));
        await new Promise(x => setTimeout(x, (j.retry_after || 1) * 1000));
        continue;
      }
      return r.status;
    } catch (e) {
      if (i === retries - 1) return 0;
      await new Promise(x => setTimeout(x, 500));
    }
  }
  return 429;
}

// ==================== SERVER ====================
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && (url === '/' || url === '/health')) {
    res.writeHead(200);
    return res.end('ok');
  }

  if (req.method !== 'POST' || url !== ROUTE) {
    res.writeHead(404);
    return res.end('not found');
  }

  try {
    const raw = await readBody(req);
    let p;
    try { p = JSON.parse(raw); }
    catch { return send(res, 400, { ok: false, error: 'bad json' }); }

    // ---------- 1. Verify HMAC ----------
    const authTime  = String(req.headers['x-auth-time']  || '');
    const authToken = String(req.headers['x-auth-token'] || '');

    if (!/^\d+$/.test(authTime))
      return send(res, 401, { ok: false, error: 'no time' });

    if (Math.abs(Math.floor(Date.now() / 1000) - parseInt(authTime, 10)) > MAX_SKEW)
      return send(res, 401, { ok: false, error: 'time skew' });

    if (!authToken)
      return send(res, 401, { ok: false, error: 'no token' });

    const canonical =
      canonicalField(authTime) +
      canonicalField(p.jobId   ?? '') +
      canonicalField(p.placeId ?? '') +
      canonicalField(p.type    ?? '') +
      canonicalField(p.name    ?? '') +
      canonicalField(p.deleted ? 1 : 0);

    const expected = b64url(
      crypto.createHmac('sha256', SECRET_KEY).update(canonical, 'utf8').digest()
    );

    if (!safeEqual(expected, authToken))
      return send(res, 401, { ok: false, error: 'bad token' });

    // ---------- 2. Route ----------
    const type  = String(p.type ?? '');
    const name  = String(p.name ?? '');
    const isDel = !!p.deleted;

    let routeKey, webhookUrl;

    if (isDel) {
      routeKey   = 'Deleted';
      webhookUrl = WEBHOOKS.Deleted;
    } else if (type === 'Event') {
      const k = `Event:${name}`;
      routeKey   = WEBHOOKS[k] ? k : 'Event';
      webhookUrl = WEBHOOKS[routeKey];
    } else {
      routeKey   = type;
      webhookUrl = WEBHOOKS[routeKey];
    }

    webhookUrl = webhookUrl || FALLBACK;

    if (!webhookUrl)
      return send(res, 500, { ok: false, error: `no webhook: ${routeKey}` });

    // ---------- 3. Send ----------
    const dc = await postWebhook(webhookUrl, {
      username: 'Blox Reporter',
      embeds:   [buildEmbed(p, routeKey)],
    });

    const ok = dc >= 200 && dc < 300;
    return send(res, ok ? 200 : 502, { ok, route: routeKey, dc });

  } catch (e) {
    console.error('[error]', e.message);
    return send(res, 500, { ok: false, error: 'internal' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[blox-reporter] listening on ${HOST}:${PORT}${ROUTE}`);

  for (const [route, url] of Object.entries(WEBHOOKS)) {
    if (!url) console.warn(`[warn] missing webhook for '${route}'`);
  }
  if (!FALLBACK) console.warn('[warn] missing WEBHOOK_FALLBACK');
});
