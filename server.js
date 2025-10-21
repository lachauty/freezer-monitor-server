// server.js
// Express ingest + Lowdb storage + Alerts (Email & Discord) + Admin UI + CSV export + Test route
// Node 18+ (uses global fetch in discord.js helper)

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs/promises');

dotenv.config();

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

function adminAuth(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  const t = req.get('X-Admin-Token') || req.query.token || '';
  if (t === ADMIN_TOKEN) return next();
  res.status(403).json({ error: 'forbidden' });
}

// --- Email/SMS status log (for visibility) ---
const emailEnabled =
  !!process.env.SMTP_HOST &&
  !!process.env.SMTP_USER &&
  !!process.env.SMTP_PASS;

console.log(
  "Email-to-SMS:",
  emailEnabled ? "SMTP CONNECTABLE" : "DRY-RUN (missing SMTP_*)",
  "| FROM=",
  process.env.ALERT_FROM_EMAIL || process.env.SMTP_USER || "(missing)"
);

// --- Discord (optional) ---
const { postToDiscord, buildFreezerEmbed } = require('./discord');

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const DISCORD_USERNAME = process.env.DISCORD_USERNAME || 'Freezer Monitor';
const DISCORD_AVATAR_URL = process.env.DISCORD_AVATAR_URL || '';
const DISCORD_THREAD_ID = process.env.DISCORD_THREAD_ID || '';
const DISCORD_MIN_SECONDS_BETWEEN_POSTS = Number(process.env.DISCORD_MIN_SECONDS_BETWEEN_POSTS || 0);

console.log(
  "Discord:",
  DISCORD_WEBHOOK_URL ? "ENABLED (env default)" : "OFF until set in /admin",
  "| Thread:", DISCORD_THREAD_ID || "(none)",
  "| MinGapSec:", DISCORD_MIN_SECONDS_BETWEEN_POSTS
);

const { createAlertManager, setConfigGetter } = require('./alerts');
const alerts = createAlertManager();

const app = express();

app.use(cors({ origin: false }));
app.use(express.json({ limit: '64kb' }));

// --- Env knobs (env defaults; DB config can override at runtime) ---
const PORT = parseInt(process.env.PORT || '3000', 10);
const API_KEY = process.env.API_KEY || '';
const LOWER = Number(process.env.LOWER_BOUND_C ?? -90);
const UPPER = Number(process.env.UPPER_BOUND_C ?? -70);
const DEDUP_DELTA_C = Number(process.env.DEDUP_DELTA_C ?? 0.2);
const KEEPALIVE_MS = Number(process.env.KEEPALIVE_MS ?? 300000);

// --- Lowdb (JSON on disk) ---
let db;
async function initDb() {
  const { Low } = await import('lowdb');
  const { JSONFile } = await import('lowdb/node');
  const dataDir = process.env.DATA_DIR || __dirname; // e.g., mount /data in prod
  await fs.mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, 'db.json');
  db = new Low(new JSONFile(file), { readings: [] });
  await db.read();
  db.data ||= { readings: [], devices: {}, config: {} };
}
const ready = initDb();

// expose DB config to alerts/discord layers
function getConfig() { return db?.data?.config || {}; }
setConfigGetter(getConfig);

// --- In-memory last-state, for ingest de-dup persistence ---
/** device_id -> { lastSavedTemp, lastSavedAt, lastSr, lastSeenAt } */
const last = new Map();

// Small helper for /status
function statesSnapshot() {
  try { return alerts.getStates ? alerts.getStates() : []; } catch { return []; }
}

// Heartbeat offline checks
setInterval(() => alerts.checkHeartbeats(), 60_000);

// --- Simple ingest auth (optional but cheap) ---
function auth(req, _res, next) {
  const k = req.get('X-API-Key') || '';
  if (!API_KEY || k === API_KEY) return next();
  return next({ status: 403, message: 'forbidden' });
}

// --- Discord notifier (respects runtime config + alerts_enabled) ---
async function notifyDiscord(evt) {
  const cfg = getConfig();

  // Respect the global enable switch
  if (!cfg.alerts_enabled) return;

  const targetWebhook = cfg.discord_webhook_url || DISCORD_WEBHOOK_URL;
  if (!targetWebhook) return; // skip if not configured

  // evt shape: { kind: 'alert'|'recover'|'offline'|'online'|'fault'|'heartbeat', id, t, lower, upper, when, url }
  const kind = evt.kind || 'alert';
  const rawId = evt.id || 'ESP32';
  const name = (db?.data?.devices && db.data.devices[rawId]?.name) || '';
  const deviceId = name ? `${name} (${rawId})` : rawId;
  const tempC = typeof evt.t === 'number' ? evt.t : undefined;
  const lower = (evt.lower ?? (typeof cfg.lowerC === 'number' ? cfg.lowerC : LOWER));
  const upper = (evt.upper ?? (typeof cfg.upperC === 'number' ? cfg.upperC : UPPER));
  const whenIso = evt.when || new Date().toISOString();
  const minGapSec = Number(cfg.discord_min_gap_sec ?? DISCORD_MIN_SECONDS_BETWEEN_POSTS);
  const threadId = cfg.discord_thread_id || DISCORD_THREAD_ID;

  let status;
  switch (kind) {
    case 'recover':  status = '✅ Recovered (back in range)'; break;
    case 'offline':  status = '❌ Offline'; break;
    case 'online':   status = '🟢 Online'; break;
    case 'fault':    status = '⚠️ Sensor Fault'; break;
    case 'heartbeat':status = 'ℹ️ Heartbeat'; break;
    case 'alert':
    default:         status = '🚨 Out of Range'; break;
  }

  const embeds = buildFreezerEmbed({
    deviceId,
    tempC,
    bounds: `${lower}…${upper} °C`,
    status,
    whenIso,
    url: evt.url
  });

  const res = await postToDiscord(
    `${status}: **${deviceId}**${typeof tempC === 'number' ? ` at ${tempC}°C` : ''}`,
    embeds,
    {
      username: DISCORD_USERNAME || undefined,
      avatar_url: DISCORD_AVATAR_URL || undefined,
      thread_id: threadId || undefined,
      webhook_url: targetWebhook,
      min_gap_sec: minGapSec
    }
  );

  if (!res.ok && !res.skipped) {
    console.warn("Discord post failed:", res);
  }
}
alerts.setNotifier(notifyDiscord);

// --- Routes ---
app.get('/health', async (_req, res) => {
  await ready;
  res.json({
    ok: true,
    readings: db.data.readings.length,
    devices: Object.keys(db.data.devices || {}).length,
    env: { LOWER, UPPER, DEDUP_DELTA_C, KEEPALIVE_MS }
  });
});

app.get('/export.csv', adminAuth, async (req, res) => {
  await ready;
  const id = req.query.device_id;
  if (!id) return res.status(400).send('device_id required');

  const fromIso = req.query.from ? new Date(req.query.from) : null;
  const toIso   = req.query.to   ? new Date(req.query.to)   : null;
  if ((fromIso && Number.isNaN(fromIso.getTime())) || (toIso && Number.isNaN(toIso.getTime()))) {
    return res.status(400).send('invalid from/to');
  }

  const rows = db.data.readings.filter(r => r.device_id === id && (
    (!fromIso || new Date(r.ts) >= fromIso) &&
    (!toIso   || new Date(r.ts) <= toIso)
  ));

  if (rows.length > 200000) return res.status(413).send('too many rows; narrow your time range');

  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${id}.csv"`);

  res.write('ts,ts_ms,temp_c,sr,device_id\n');
  for (const r of rows) res.write(`${r.ts},${r.ts_ms ?? ''},${r.temp_c},${r.sr},${r.device_id}\n`);
  res.end();
});

app.get('/status', adminAuth, (_req, res) => {
  res.json({ devices: statesSnapshot() });
});

// Reset per-device overrides
app.post('/devices/:id/reset', adminAuth, async (req, res) => {
  await ready;
  const id = req.params.id;
  if (db.data.devices) delete db.data.devices[id];
  await db.write();
  res.json({ ok: true, id });
});

// Ingest endpoint
app.post('/ingest', auth, async (req, res) => {
  if ((req.get('content-type') || '').indexOf('application/json') !== 0) {
    return res.status(415).json({ error: 'application/json required' });
  }
  await ready;

  const { device_id, temp_c, sr, ts_ms } = req.body || {};
  if (!device_id || typeof temp_c !== 'number') {
    return res.status(400).json({ error: 'device_id and temp_c required' });
  }

  // Drop obviously bad readings
  if (!Number.isFinite(temp_c) || temp_c < -200 || temp_c > 1200) {
    console.warn(`bad reading from ${device_id}: temp_c=${temp_c}`);
    return res.sendStatus(200);
  }

  const clientTs = Number(ts_ms);
  const now = Date.now();
  // accept device ts within ±48h and not NaN
  const withinWindow = Number.isFinite(clientTs) && Math.abs(clientTs - now) < 48 * 3600 * 1000;
  const tsUse = withinWindow ? clientTs : now;
  if (!withinWindow && Number.isFinite(clientTs)) {
    console.warn(`ts_ms out of window; using server time. device=${clientTs} server=${now}`);
  }

  const prev = last.get(device_id) || { lastSavedTemp: undefined, lastSavedAt: 0, lastSr: undefined, lastSeenAt: 0 };
  const delta = Number.isFinite(prev.lastSavedTemp) ? Math.abs(temp_c - prev.lastSavedTemp) : Infinity;
  let reason = '';
  let shouldSave = false;

  const srNum = (sr >>> 0) || 0;

  const devCfg = (db.data.devices && db.data.devices[device_id]) || null;
  const cfg = getConfig();
  const lowerOverride =
    (devCfg && typeof devCfg.lowerC === 'number') ? devCfg.lowerC :
    (typeof cfg.lowerC === 'number' ? cfg.lowerC : undefined);
  const upperOverride =
    (devCfg && typeof devCfg.upperC === 'number') ? devCfg.upperC :
    (typeof cfg.upperC === 'number' ? cfg.upperC : undefined);

  alerts.updateReading({
    id: device_id,
    t: temp_c,
    sr: srNum,
    ts: tsUse,
    lower: lowerOverride,
    upper: upperOverride,
  });

  if (!Number.isFinite(prev.lastSavedTemp)) { shouldSave = true; reason = 'first'; }
  else if (delta >= DEDUP_DELTA_C) { shouldSave = true; reason = `delta>=${DEDUP_DELTA_C}`; }
  else if (tsUse - prev.lastSavedAt >= KEEPALIVE_MS) { shouldSave = true; reason = `heartbeat>${KEEPALIVE_MS}ms`; }

  // If fault status changes, save immediately
  if (!shouldSave && prev.lastSr !== undefined && prev.lastSr !== srNum) {
    shouldSave = true; reason = 'fault-change';
  }

  // Update last-seen regardless
  last.set(device_id, {
    lastSavedTemp: shouldSave ? temp_c : prev.lastSavedTemp,
    lastSavedAt: shouldSave ? tsUse : prev.lastSavedAt,
    lastSr: shouldSave ? srNum : (prev.lastSr ?? srNum),
    lastSeenAt: tsUse,
  });

  if (shouldSave) {
    const rec = {
      ts: new Date(tsUse).toISOString(),
      ts_ms: tsUse,
      device_id,
      temp_c: Math.round(temp_c * 100) / 100,
      sr: srNum,
    };
    db.data.readings.push(rec);
    await db.write();
    console.log(`save [${device_id}] t=${rec.temp_c}°C sr=0x${srNum.toString(16).padStart(2, '0')} Δ=${Number.isFinite(delta) ? delta.toFixed(2) : '—'} (${reason})`);
  }

  return res.sendStatus(200);
});

// Quick alert test (no auth) — uses alerts manager only (no duplicate)
app.post('/_test/alert', (req, res) => {
  const id = (req.body && req.body.id) || 'test-device';
  const cfg = getConfig();
  const lower = (typeof cfg.lowerC === 'number') ? cfg.lowerC : Number(process.env.LOWER_BOUND_C ?? -90);
  const upper = (typeof cfg.upperC === 'number') ? cfg.upperC : Number(process.env.UPPER_BOUND_C ?? -70);
  const t = (typeof req.body?.t === 'number') ? req.body.t : (upper + 1);

  alerts.updateReading({ id, t, sr: 0, ts: Date.now(), lower, upper });
  res.json({ ok: true, sent: `Out-of-range for ${id} at ${t}°C (bounds ${lower}..${upper})` });
});

// --- Devices API (minimal) ---
app.get('/devices', adminAuth, async (_req, res) => {
  await ready;

  const ids = new Set(db.data.readings.map(r => r.device_id));
  Object.keys(db.data.devices || {}).forEach(id => ids.add(id));

  const latestById = {};
  for (let i = db.data.readings.length - 1; i >= 0; i--) {
    const r = db.data.readings[i];
    if (!latestById[r.device_id]) latestById[r.device_id] = r;
  }

  const out = [...ids].map(id => ({
    id,
    cfg: (db.data.devices && db.data.devices[id]) || null,
    latest: latestById[id] || null,
  }));
  res.json({ devices: out });
});

app.get('/devices/:id', adminAuth, async (req, res) => {
  await ready;
  const id = req.params.id;
  const cfg = (db.data.devices && db.data.devices[id]) || null;
  const latestRec = [...db.data.readings].reverse().find(r => r.device_id === id) || null;
  res.json({ id, cfg, latest: latestRec });
});

app.put('/devices/:id', adminAuth, async (req, res) => {
  await ready;
  const id = req.params.id;
  const { lowerC, upperC, name, notes } = req.body || {};

  const cfg = (db.data.devices && db.data.devices[id]) || {};
  if (lowerC !== undefined) {
    if (typeof lowerC !== 'number' || !Number.isFinite(lowerC)) {
      return res.status(400).json({ error: 'lowerC must be a number' });
    }
    cfg.lowerC = lowerC;
  }
  if (upperC !== undefined) {
    if (typeof upperC !== 'number' || !Number.isFinite(upperC)) {
      return res.status(400).json({ error: 'upperC must be a number' });
    }
    cfg.upperC = upperC;
  }
  if (name !== undefined) cfg.name = String(name).slice(0, 80);
  if (notes !== undefined) cfg.notes = String(notes).slice(0, 400);

  db.data.devices ||= {};
  db.data.devices[id] = cfg;
  await db.write();
  res.json({ ok: true, id, cfg });
});

// ---- Global config API (in db.data.config) ----
app.get('/config', adminAuth, async (_req, res) => {
  await ready;
  res.json({ config: db.data.config || {} });
});

app.put('/config', adminAuth, async (req, res) => {
  await ready;
  const body = req.body || {};
  const cfg = db.data.config || {};

  // Validate ranges if provided
  if (body.lowerC !== undefined) {
    const n = Number(body.lowerC);
    if (!Number.isFinite(n) || n < -100 || n >= 50) return res.status(400).json({ error: 'lowerC out of range' });
    cfg.lowerC = n;
  }
  if (body.upperC !== undefined) {
    const n = Number(body.upperC);
    if (!Number.isFinite(n) || n <= -100 || n > 50) return res.status(400).json({ error: 'upperC out of range' });
    cfg.upperC = n;
  }
  if (cfg.lowerC !== undefined && cfg.upperC !== undefined && cfg.lowerC >= cfg.upperC) {
    return res.status(400).json({ error: 'lowerC must be < upperC' });
  }

  // Alerts master switch
  if (body.alerts_enabled !== undefined) {
    const val = (typeof body.alerts_enabled === 'string')
      ? ['1','true','on','yes'].includes(body.alerts_enabled.toLowerCase())
      : !!body.alerts_enabled;
    cfg.alerts_enabled = val;
  }

  // Alert recipients (comma-separated emails; phones via carrier gateways)
  if (body.alert_to_email !== undefined) {
    cfg.alert_to_email = String(body.alert_to_email).trim();
  }
  if (body.alert_from_email !== undefined) {
    cfg.alert_from_email = String(body.alert_from_email).trim();
  }

  // Discord
  if (body.discord_webhook_url !== undefined) {
    const s = String(body.discord_webhook_url).trim();
    if (s && !s.startsWith('https://discord.com/api/webhooks/')) {
      return res.status(400).json({ error: 'discord_webhook_url looks invalid' });
    }
    cfg.discord_webhook_url = s;
  }
  if (body.discord_thread_id !== undefined) cfg.discord_thread_id = String(body.discord_thread_id).trim();
  if (body.discord_min_gap_sec !== undefined) {
    const n = Number(body.discord_min_gap_sec);
    if (!Number.isFinite(n) || n < 0 || n > 3600) return res.status(400).json({ error: 'discord_min_gap_sec invalid' });
    cfg.discord_min_gap_sec = n;
  }

  db.data.config = cfg;
  await db.write();
  res.json({ ok: true, config: cfg });
});

app.post('/config/reset', adminAuth, async (_req, res) => {
  await ready;
  db.data.config = {};
  await db.write();
  res.json({ ok: true });
});

// --- Admin UI ---
app.get('/admin', adminAuth, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(`<!doctype html><meta charset="utf-8">
<title>Freezer Admin</title>
<style>
  :root{--b:#ddd;--t:#222;--m:24px}
  body{font-family:system-ui,Segoe UI,Roboto,Apple Color Emoji,Noto Color Emoji;margin:var(--m);color:var(--t)}
  input,button{padding:.45rem .6rem;font:inherit}
  table{border-collapse:collapse;margin-top:12px;width:100%}
  td,th{border:1px solid var(--b);padding:.45rem .6rem;text-align:left}
  .hint{color:#666;margin:.5rem 0}
  .pill{display:inline-block;padding:.15rem .45rem;border-radius:999px;border:1px solid var(--b);font-size:.85rem;cursor:pointer}
  .warn{margin-top:8px;padding:8px;border:1px dashed #f39;color:#b00;background:#fff4f6}
</style>
<h1>Freezer Admin</h1>
<div class="hint">Edit per-device bounds. Leave blank to use global env (${LOWER}…${UPPER} °C). Use Global Settings to set recipients & Discord.</div>
<div id="root">Loading…</div>
<script>
const token = new URLSearchParams(location.search).get('token') || '';

function q(v){ return v==null ? '' : v; }

async function load(){
  const [devRes, cfgRes] = await Promise.all([
    fetch('/devices'+(token?('?token='+encodeURIComponent(token)) : '')),
    fetch('/config'+(token?('?token='+encodeURIComponent(token)) : ''))
  ]);
  const dev = await devRes.json();
  const cfg = await cfgRes.json();
  const c = cfg.config || {};

  const el=document.getElementById('root');
  el.innerHTML = \`
  <section style="margin:8px 0;padding:12px;border:1px solid var(--b);border-radius:8px">
    <h2 style="margin:0 0 8px 0">Global Settings</h2>
    <form id="globalForm" onsubmit="return saveConfig(event)">
      <div class="warn" id="alerts_warning" style="display:\${c.alerts_enabled ? 'none':'block'}">
        Alerts are <b>disabled</b>. No email/SMS/Discord messages will be sent until you enable them and set recipients.
      </div>
      <div style="margin:8px 0">
        <label style="display:inline-flex; gap:8px; align-items:center;">
          <input type="checkbox" name="alerts_enabled" id="alerts_enabled" \${c.alerts_enabled ? 'checked':''}>
          Enable alerts (email/SMS + Discord)
        </label>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <label>Default Lower (°C): <input name="lowerC" type="number" step="0.1" value="\${q(c.lowerC)}"></label>
        <label>Default Upper (°C): <input name="upperC" type="number" step="0.1" value="\${q(c.upperC)}"></label>
        <label>Alert To (email or 10digit@carrier): <input name="alert_to_email" placeholder="e.g. 4155551212@vzwpix.com" value="\${q(c.alert_to_email)}"></label>
        <label>From Email (optional): <input name="alert_from_email" value="\${q(c.alert_from_email)}"></label>
      </div>
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
        <label>Discord Webhook URL: <input name="discord_webhook_url" style="min-width:420px" placeholder="https://discord.com/api/webhooks/..." value="\${q(c.discord_webhook_url)}"></label>
        <label>Thread ID (optional): <input name="discord_thread_id" value="\${q(c.discord_thread_id)}"></label>
        <label>Min Gap (s): <input name="discord_min_gap_sec" type="number" min="0" step="1" value="\${q(c.discord_min_gap_sec)}"></label>
      </div>
      <div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap">
        <button>Save</button>
        <button type="button" onclick="testAlert()">Send Test Alert</button>
        <button type="button" onclick="resetConfig()">Reset to Defaults</button>
      </div>
    </form>
  </section>
  <table>
    <tr><th>ID</th><th>Name</th><th>Last Temp</th><th>Bounds</th><th>Edit</th></tr>
    \${dev.devices.map(d=>{
      const last = d.latest ? \`\${d.latest.temp_c}°C @ \${d.latest.ts}\` : '—';
      const lo = (d.cfg && d.cfg.lowerC!=null)? d.cfg.lowerC : '${LOWER}';
      const hi = (d.cfg && d.cfg.upperC!=null)? d.cfg.upperC : '${UPPER}';
      const name = d.cfg?.name || '';
      return \`
        <tr>
          <td>\${d.id}</td>
          <td>\${name}</td>
          <td>\${last}</td>
          <td>\${lo}…\${hi}</td>
          <td>
            <form onsubmit="return saveDevice(event,'\${d.id}')">
              <input name="name" placeholder="name" value="\${name}">
              <input name="lowerC" type="number" step="0.1" placeholder="lower" value="\${d.cfg?.lowerC ?? ''}">
              <input name="upperC" type="number" step="0.1" placeholder="upper" value="\${d.cfg?.upperC ?? ''}">
              <button>Save</button>
              <a class="pill" href="/export.csv?device_id=\${encodeURIComponent(d.id)}\${token?('&token='+encodeURIComponent(token)) : ''}">Export CSV</a>
              <button type="button" class="pill" onclick="resetDevice('\${d.id}')">Reset</button>
            </form>
          </td>
        </tr>\`;
    }).join('')}
  </table>\`;
}

async function saveDevice(ev,id){
  ev.preventDefault();
  const f=new FormData(ev.target);
  const body={};
  for(const [k,v] of f.entries()){
    if(k==='lowerC'||k==='upperC'){ if(v!=='') body[k]=Number(v); }
    else if(k==='name'){ body[k]=v; }
  }
  const r=await fetch('/devices/'+encodeURIComponent(id)+(token?('?token='+encodeURIComponent(token)):''),{
    method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
  });
  if(!r.ok){alert('Save failed: '+await r.text());return false;}
  load(); return false;
}

async function saveConfig(ev){
  ev.preventDefault();
  const f = new FormData(ev.target);
  const body = {};
  // always send alerts_enabled
  body.alerts_enabled = document.getElementById('alerts_enabled')?.checked ? true : false;
  for (const [k,v] of f.entries()) {
    if (k==='alerts_enabled') continue; // handled above
    if (v === '') continue;
    if (k==='lowerC' || k==='upperC' || k==='discord_min_gap_sec') body[k] = Number(v);
    else body[k] = v;
  }
  const r = await fetch('/config'+(token?('?token='+encodeURIComponent(token)) : ''), {
    method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
  if (!r.ok) { alert('Save failed: '+await r.text()); return false; }
  load();
  return false;
}

async function resetConfig(){
  if (!confirm('Reset ALL global settings to defaults from .env?')) return;
  const r = await fetch('/config/reset'+(token?('?token='+encodeURIComponent(token)) : ''), { method:'POST' });
  if (!r.ok) { alert('Reset failed: '+await r.text()); return; }
  load();
}

async function testAlert(){
  const r = await fetch('/_test/alert', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
  if (!r.ok) { alert('Test failed: '+await r.text()); return; }
  alert('Test alert queued. Check your phone/email and Discord.');
}

async function resetDevice(id){
  if (!confirm('Reset overrides for device '+id+'?')) return;
  const r = await fetch('/devices/'+encodeURIComponent(id)+'/reset'+(token?('?token='+encodeURIComponent(token)) : ''), { method:'POST' });
  if (!r.ok) { alert('Device reset failed: '+await r.text()); return; }
  load();
}

load();
</script>`);
});

// --- Error handler (minimal) ---
app.use((err, _req, res, _next) => {
  const code = err?.status || 500;
  res.status(code).json({ error: err?.message || 'internal_error' });
});

ready.then(() => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
  console.log(`Bounds: LOWER=${LOWER} UPPER=${UPPER}`);
  console.log(`Dedup: Δ≥${DEDUP_DELTA_C}°C, heartbeat=${KEEPALIVE_MS / 1000}s`);
  app.listen(PORT, '0.0.0.0');
});

process.on('SIGTERM', () => {
  console.log('Shutting down…');
  process.exit(0);
});
