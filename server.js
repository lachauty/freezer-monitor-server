// server.js
// Express ingest + Lowdb storage + Alerts (Email & Discord) + Test route
// Node 18+ (uses global fetch in discord.js helper)

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

// --- Email/SMS status log (for visibility) ---
const emailEnabled =
  !!process.env.SMTP_HOST &&
  !!process.env.SMTP_USER &&
  !!process.env.SMTP_PASS &&
  !!(process.env.ALERT_TO_EMAIL && process.env.ALERT_TO_EMAIL.trim());

console.log(
  "Email-to-SMS:",
  emailEnabled ? "ENABLED" : "DRY-RUN (missing SMTP_* or ALERT_TO_EMAIL)",
  "| TO=",
  (process.env.ALERT_TO_EMAIL || "").split(",").map(s => s.trim()).filter(Boolean),
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
  DISCORD_WEBHOOK_URL ? "ENABLED" : "DRY-RUN (set DISCORD_WEBHOOK_URL to enable)",
  "| Thread:", DISCORD_THREAD_ID || "(none)",
  "| MinGapSec:", DISCORD_MIN_SECONDS_BETWEEN_POSTS
);

// --- Alerts manager (email + generic notify hook) ---
const { createAlertManager } = require('./alerts');
const alerts = createAlertManager();
setInterval(() => alerts.checkHeartbeats(), 60_000); // every minute

const app = express();
app.use(cors());
app.use(express.json());

// --- Env knobs ---
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
  const file = path.join(__dirname, 'db.json');
  db = new Low(new JSONFile(file), { readings: [] });
  await db.read();
  db.data ||= { readings: [] };
}
const ready = initDb();

// --- In-memory last-state, for ingest de-dup persistence ---
/** device_id -> { lastSavedTemp, lastSavedAt, lastSr, lastSeenAt } */
const last = new Map();

// --- Simple auth middleware (optional but cheap) ---
function auth(req, _res, next) {
  const k = req.get('X-API-Key') || '';
  if (!API_KEY || k === API_KEY) return next();
  return next({ status: 403, message: 'forbidden' });
}

// --- Discord bridge helper for direct posts ---
async function notifyDiscord(evt) {
  if (!DISCORD_WEBHOOK_URL) return; // silently skip if not configured

  // evt shape: { kind: 'alert'|'recover'|'offline'|'online'|'fault'|'heartbeat', id, t, lower, upper, when, url }
  const kind = evt.kind || 'alert';
  const deviceId = evt.id || 'ESP32';
  const tempC = typeof evt.t === 'number' ? evt.t : undefined;
  const lower = (evt.lower ?? LOWER);
  const upper = (evt.upper ?? UPPER);
  const whenIso = evt.when || new Date().toISOString();

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
      thread_id: DISCORD_THREAD_ID || undefined
    }
  );

  if (!res.ok && !res.skipped) {
    console.warn("Discord post failed:", res);
  }
}

// Wire alerts → Discord (uses the built-in hook)
alerts.setNotifier(notifyDiscord);

// --- Routes ---
app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/ingest', auth, async (req, res) => {
  await ready;

  const { device_id, temp_c, sr } = req.body || {};
  if (!device_id || typeof temp_c !== 'number') {
    return res.status(400).json({ error: 'device_id and temp_c required' });
  }

  // Drop obviously bad readings (sensor mis-wired etc.). Still 200 to avoid retries.
  if (!Number.isFinite(temp_c) || temp_c < -200 || temp_c > 1200) {
    console.warn(`bad reading from ${device_id}: temp_c=${temp_c}`);
    return res.sendStatus(200);
  }

  const now = Date.now();
  const prev = last.get(device_id) || { lastSavedTemp: undefined, lastSavedAt: 0, lastSr: undefined, lastSeenAt: 0 };
  const delta = Number.isFinite(prev.lastSavedTemp) ? Math.abs(temp_c - prev.lastSavedTemp) : Infinity;
  let reason = '';
  let shouldSave = false;

  const srNum = (sr >>> 0) || 0;

  // Feed alerts on every ingest (even if we don't persist due to de-dup)
  alerts.updateReading({
    id: device_id,
    t: temp_c,
    sr: srNum,
    ts: now,
  });

  if (!Number.isFinite(prev.lastSavedTemp)) { shouldSave = true; reason = 'first'; }
  else if (delta >= DEDUP_DELTA_C) { shouldSave = true; reason = `delta>=${DEDUP_DELTA_C}`; }
  else if (now - prev.lastSavedAt >= KEEPALIVE_MS) { shouldSave = true; reason = `heartbeat>${KEEPALIVE_MS}ms`; }

  // If fault status changes, save immediately so we capture transitions.
  if (!shouldSave && prev.lastSr !== undefined && prev.lastSr !== srNum) {
    shouldSave = true; reason = 'fault-change';
  }

  // Update last-seen regardless
  last.set(device_id, {
    lastSavedTemp: shouldSave ? temp_c : prev.lastSavedTemp,
    lastSavedAt: shouldSave ? now : prev.lastSavedAt,
    lastSr: shouldSave ? srNum : (prev.lastSr ?? srNum),
    lastSeenAt: now,
  });

  if (shouldSave) {
    const rec = {
      ts: new Date(now).toISOString(),
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
  const t = (typeof req.body?.t === 'number') ? req.body.t : (Number(process.env.UPPER_BOUND_C ?? -70) + 1);
  alerts.updateReading({ id, t, sr: 0, ts: Date.now() });
  res.json({ ok: true, sent: `Out-of-range for ${id} at ${t}°C` });
});

// --- Error handler (minimal) ---
app.use((err, _req, res, _next) => {
  const code = err?.status || 500;
  res.status(code).json({ error: err?.message || 'internal_error' });
});

// --- Start server after DB is ready ---
ready.then(() => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
  console.log(`Bounds: LOWER=${LOWER} UPPER=${UPPER}`);
  console.log(`Dedup: Δ≥${DEDUP_DELTA_C}°C, heartbeat=${KEEPALIVE_MS / 1000}s`);
  app.listen(PORT, '0.0.0.0');
});
