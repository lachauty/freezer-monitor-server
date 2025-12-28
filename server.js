// server.js
// Express ingest + Lowdb storage + Alerts (Email & Discord) + Admin UI + CSV export + Test route
// Node 18+ (uses global fetch in discord.js helper)

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs/promises');

dotenv.config();

// set admin token to .env file variable or nothing
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// function to authenticate admin with parameters request, response, and next
function adminAuth(req, res, next) {
  // checks if admin token exists
  if (!ADMIN_TOKEN) return next();
  // set t to be request geting admin token or request query token or nothing
  const t = req.get('X-Admin-Token') || req.query.token || '';
  // check if t is equal to admin token in both value and token
  if (t === ADMIN_TOKEN) return next();
  // respond with status error 403 and json with error 'forbidden'
  res.status(403).json({ error: 'forbidden' });
}

// --- Email status log (for visibility) ---
const EMAIL_PROVIDER = (process.env.EMAIL_PROVIDER || 'smtp').toLowerCase();
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || '';

// let email status be "DRY-RUN"
let emailStatus = "DRY-RUN";
// if email provider is equal to resend both in value and datatype
if (EMAIL_PROVIDER === 'resend') {
  // set email status to be ok if resend api exist, else missing api
  emailStatus = RESEND_API_KEY ? "HTTPS OK (Resend)" : "MISSING RESEND_API_KEY";
} else {
  // smtpready is set to boolean value of SMTP_HOST 
  const smtpReady = !!process.env.SMTP_HOST && !!process.env.SMTP_USER && !!process.env.SMTP_PASS;
  // email status is set to ternary statement depending on smtpReady is true or false
  emailStatus = smtpReady ? "SMTP CONNECTABLE" : "DRY-RUN (missing SMTP_*)";
}

// log email and provider information
console.log(
  "Email:", emailStatus,
  "| PROVIDER=", EMAIL_PROVIDER,
  "| FROM=", process.env.ALERT_FROM_EMAIL || process.env.SMTP_USER || "(missing)"
);

// Discord (optional)
const { postToDiscord, buildFreezerEmbed } = require('./discord');

// setting discord constants to be utilized
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const DISCORD_USERNAME = process.env.DISCORD_USERNAME || 'Freezer Monitor';
const DISCORD_AVATAR_URL = process.env.DISCORD_AVATAR_URL || '';
const DISCORD_THREAD_ID = process.env.DISCORD_THREAD_ID || '';
const DISCORD_MIN_SECONDS_BETWEEN_POSTS = Number(process.env.DISCORD_MIN_SECONDS_BETWEEN_POSTS || 0);

// display discord information
console.log(
  "Discord:",
  DISCORD_WEBHOOK_URL ? "ENABLED (env default)" : "OFF until set in /admin",
  "| Thread:", DISCORD_THREAD_ID || "(none)",
  "| MinGapSec:", DISCORD_MIN_SECONDS_BETWEEN_POSTS
);

// creating objects and including the alerts.js file
const { createAlertManager, setConfigGetter } = require('./alerts');
const alerts = createAlertManager();

// create express application
const app = express();

// CORS middleware to prevent external sites allowed
app.use(cors({ origin: false }));
// json file limit it 64kb
app.use(express.json({ limit: '64kb' }));

// Env knobs (env defaults - DB config can override at runtime)
const PORT = parseInt(process.env.PORT || '3000', 10);
const API_KEY = process.env.API_KEY || '';
const LOWER = Number(process.env.LOWER_BOUND_C ?? -90);
const UPPER = Number(process.env.UPPER_BOUND_C ?? -70);
const DEDUP_DELTA_C = Number(process.env.DEDUP_DELTA_C ?? 0.2);
const KEEPALIVE_MS = Number(process.env.KEEPALIVE_MS ?? 300000);

// Lowdb (JSON on disk)
let db;
// initialize data base asynchronous function
async function initDb() {

  // importing lowdb and lowdb/node
  const { Low } = await import('lowdb');
  const { JSONFile } = await import('lowdb/node');

  // sets data directory
  const dataDir = process.env.DATA_DIR || __dirname;

  // await for file system to make a directory
  await fs.mkdir(dataDir, { recursive: true });
  // set file to data directory db.json
  const file = path.join(dataDir, 'db.json');
  // set db to Low object
  db = new Low(new JSONFile(file), { readings: [] });
  await db.read();
  // Logical OR assignment with the following fields
  db.data ||= { readings: [], devices: {}, config: {} };
}

// initialize Database
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

// Simple ingest auth (optional but cheap)
function auth(req, _res, next) {
  const k = req.get('X-API-Key') || '';
  if (!API_KEY || k === API_KEY) return next();
  return next({ status: 403, message: 'forbidden' });
}

// Discord notifier (respects runtime config + alerts_enabled)
async function notifyDiscord(evt) {
  const cfg = getConfig();

  // Respect the global enable switch
  if (!cfg.alerts_enabled) return;
  if (!cfg.discord_enabled) return;

  // set target webhook 
  const targetWebhook = cfg.discord_webhook_url || DISCORD_WEBHOOK_URL;
  if (!targetWebhook) return; // skip if not configured

  // set kind to evt.kind field or alert
  // set rawId to evt.id field or esp32
  const kind = evt.kind || 'alert';
  const rawId = evt.id || 'ESP32';

  // ?. optional chaining, checks if left variable exists
  // if not check right, and if not right check right right or leave empty
  const name = (db?.data?.devices && db.data.devices[rawId]?.name) || '';
  // set deviceId to name and rawId if name exist else set to rawId
  const deviceId = name ? `${name} (${rawId})` : rawId;

  // set temperature in Celsius to evt.t if evt.t is the same datatype and value else leave as undefined
  const tempC = typeof evt.t === 'number' ? evt.t : undefined;

  // null coalescing statement -> checks if NULL then move onto ternary statement
  const lower = (evt.lower ?? (typeof cfg.lowerC === 'number' ? cfg.lowerC : LOWER));
  const upper = (evt.upper ?? (typeof cfg.upperC === 'number' ? cfg.upperC : UPPER));

  // set whenIso to evt.when ORed with the new date
  const whenIso = evt.when || new Date().toISOString();
  
  // minGapSec is set to number and checks if cfg field is null then set to defined variable
  const minGapSec = Number(cfg.discord_min_gap_sec ?? DISCORD_MIN_SECONDS_BETWEEN_POSTS);
  const threadId = cfg.discord_thread_id || DISCORD_THREAD_ID;

  // instantiate status, and use kind, as a case statement
  // we define the status as the associated kind of notification
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

  // we are creating a buildFreezerEmbed object
  // with the following fields
  const embeds = buildFreezerEmbed({
    deviceId,
    tempC,
    bounds: `${lower}…${upper} °C`,
    status,
    whenIso,
    url: evt.url
  });

  // set response to wait for post to discord
  const res = await postToDiscord(
    // set status 
    `${status}: **${deviceId}**${typeof tempC === 'number' ? ` at ${tempC}°C` : ''}`,
    embeds,
    {
      // set populated fields to ORed with undefined or following parameters
      username: DISCORD_USERNAME || undefined,
      avatar_url: DISCORD_AVATAR_URL || undefined,
      thread_id: threadId || undefined,
      webhook_url: targetWebhook,
      min_gap_sec: minGapSec
    }
  );

  // checks if response ok field and response skipped is false
  if (!res.ok && !res.skipped) {
    // if it is issue a failure warning
    console.warn("Discord post failed:", res);
  }
}
// set Notifier
alerts.setNotifier(notifyDiscord);

// Routes
// get the health route and set an asynchronous 
app.get('/health', async (_req, res) => {
  await ready;
  // populate response json file fields
  res.json({
    ok: true,
    readings: db.data.readings.length,
    // set device to object key field if db.data.devices isn't falsy, ||{} protects if falsy
    // falsy is false, 0, 0n, NaN, undefined, "", and null
    devices: Object.keys(db.data.devices || {}).length,
    env: { LOWER, UPPER, DEDUP_DELTA_C, KEEPALIVE_MS }
  });
});

// This registers a route in express
app.get('/export.csv', adminAuth, async (req, res) => {
  
  await ready;
  // set id to request query device id object field
  const id = req.query.device_id;
  // check id if it's false to return a status for id required
  if (!id) return res.status(400).send('device_id required');

  // set fromIso to new date object or null depending if request query field exists
  const fromIso = req.query.from ? new Date(req.query.from) : null;
  const toIso   = req.query.to   ? new Date(req.query.to)   : null;
  
  // if statement that checks fromIso ANDed to check for NaN and get time ORed with toIso ANDed with gettime
  if ((fromIso && Number.isNaN(fromIso.getTime())) || (toIso && Number.isNaN(toIso.getTime()))) {
    return res.status(400).send('invalid from/to');
  }

  // sets rows to be database readings filtered for r.device_id to check id to be equal in value and data type
  // ANDed to check if fromIso is false and ORed with new date
  const rows = db.data.readings.filter(r => r.device_id === id && (
    (!fromIso || new Date(r.ts) >= fromIso) &&
    (!toIso   || new Date(r.ts) <= toIso)
  ));

  // checks rows length field is greater than 200000 and returns response status error
  if (rows.length > 200000) return res.status(413).send('too many rows; narrow your time range');

  // response set header
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${id}.csv"`);

  // response write temperature and details
  res.write('ts,ts_ms,temp_c,sr,device_id\n');
  // for loop iterating through rows using r
  // to write r.ts_ms 
  for (const r of rows) res.write(`${r.ts},${r.ts_ms ?? ''},${r.temp_c},${r.sr},${r.device_id}\n`);
  res.end();
});

// get status and req, response to populate json file
app.get('/status', adminAuth, (_req, res) => {
  res.json({ devices: statesSnapshot() });
});

// Reset per-device overrides
app.post('/devices/:id/reset', adminAuth, async (req, res) => {
  await ready;
  const id = req.params.id;
  // if db fields exists delete associate id
  if (db.data.devices) delete db.data.devices[id];
  // write database
  await db.write();
  res.json({ ok: true, id });
});

// Ingest endpoint
app.post('/ingest', auth, async (req, res) => {
  // checks if incoming HTTP request is JSON
  // if request is NOT JSON the server rejects it with 415 error
  if ((req.get('content-type') || '').indexOf('application/json') !== 0) {
    return res.status(415).json({ error: 'application/json required' });
  }
  await ready;

  // sets id, tempc, sr, and ts_ms to request body field or empty
  const { device_id, temp_c, sr, ts_ms } = req.body || {};
  // if device id false ORed with type of temp_C not equal to value and datatype
  if (!device_id || typeof temp_c !== 'number') {
    return res.status(400).json({ error: 'device_id and temp_c required' });
  }

  // Drop obviously bad readings
  if (!Number.isFinite(temp_c) || temp_c < -200 || temp_c > 1200) {
    // logs and returns status 200
    console.warn(`bad reading from ${device_id}: temp_c=${temp_c}`);
    return res.sendStatus(200);
  }

  // set clientTs to the number 64 bit of ts_ms
  const clientTs = Number(ts_ms);
  // set now as the time now
  const now = Date.now();
  // accept device ts within ±48h and not NaN
  // withinWindow is set to clientTs ANDed with absolute value of clientTs - now less than 48 * 3600 * 1000
  const withinWindow = Number.isFinite(clientTs) && Math.abs(clientTs - now) < 48 * 3600 * 1000;
  // set tsUse to clientTs if withinWindow else now
  const tsUse = withinWindow ? clientTs : now;
  // if withinWindow is false ANDed with clientTs
  if (!withinWindow && Number.isFinite(clientTs)) {
    //logs warning
    console.warn(`ts_ms out of window; using server time. device=${clientTs} server=${now}`);
  }

  // set prev to device_id ORed with following fields
  const prev = last.get(device_id) || { lastSavedTemp: undefined, lastSavedAt: 0, lastSr: undefined, lastSeenAt: 0 };
  // set delta to absolute value else infinity if prev.lastSavedTemp is finite
  const delta = Number.isFinite(prev.lastSavedTemp) ? Math.abs(temp_c - prev.lastSavedTemp) : Infinity;
  let reason = '';
  let shouldSave = false;

  //unsigned right shift register to convert to a 32 bit ORed with 0
  const srNum = (sr >>> 0) || 0;

  // set devcfg to db ANDed with db of device id ORed with null
  const devCfg = (db.data.devices && db.data.devices[device_id]) || null;
  // set cfg to getConfig
  const cfg = getConfig();

  // set lowerOverride to the following ternary statements
  const lowerOverride =
    (devCfg && typeof devCfg.lowerC === 'number') ? devCfg.lowerC :
    (typeof cfg.lowerC === 'number' ? cfg.lowerC : LOWER);
  const upperOverride =
    (devCfg && typeof devCfg.upperC === 'number') ? devCfg.upperC :
    (typeof cfg.upperC === 'number' ? cfg.upperC : UPPER);

    // populate the following object with the feels
  alerts.updateReading({
    id: device_id,
    t: temp_c,
    sr: srNum,
    ts: tsUse,
    lower: lowerOverride,
    upper: upperOverride,
  });

  // check if the prev.lastsavedtemp is finite, if it is, set should save to true and reason first
  if (!Number.isFinite(prev.lastSavedTemp)) { shouldSave = true; reason = 'first'; }
  // elseif check delta is greater or equal to dedup delta c, if it is set to true and the reason to the string
  else if (delta >= DEDUP_DELTA_C) { shouldSave = true; reason = `delta>=${DEDUP_DELTA_C}`; }
  // check if tsUse subtracted prev last saved at >= keep alive_ms
  // if it is set should save to true and reason to string values
  else if (tsUse - prev.lastSavedAt >= KEEPALIVE_MS) { shouldSave = true; reason = `heartbeat>${KEEPALIVE_MS}ms`; }

  // If fault status changes, save immediately
  if (!shouldSave && prev.lastSr !== undefined && prev.lastSr !== srNum) {
    shouldSave = true; reason = 'fault-change';
  }

  // Update last-seen regardless
  last.set(device_id, {
    
    //set fields to ternary statements if shouldSave is true
    lastSavedTemp: shouldSave ? temp_c : prev.lastSavedTemp,
    lastSavedAt: shouldSave ? tsUse : prev.lastSavedAt,
    lastSr: shouldSave ? srNum : (prev.lastSr ?? srNum),
    lastSeenAt: tsUse,
  });

  //if shouldSave is true
  if (shouldSave) {
    //populate object fields with the following
    const rec = {
      ts: new Date(tsUse).toISOString(),
      ts_ms: tsUse,
      device_id,
      temp_c: Math.round(temp_c * 100) / 100,
      sr: srNum,
    };
    // push database readings with record
    db.data.readings.push(rec);
    //await for database write
    await db.write();
    // log the saved record
    console.log(`save [${device_id}] t=${rec.temp_c}°C sr=0x${srNum.toString(16).padStart(2, '0')} Δ=${Number.isFinite(delta) ? delta.toFixed(2) : '—'} (${reason})`);
  }

  // return with success
  return res.sendStatus(200);
});


// Quick alert test (no auth) — uses alerts manager only (no duplicate)
app.post('/_test/alert', (req, res) => {
  // set fields depending on the following comparators
  const id = (req.body && req.body.id) || 'test-device';
  const cfg = getConfig();
  const lower = (typeof cfg.lowerC === 'number') ? cfg.lowerC : Number(process.env.LOWER_BOUND_C ?? -90);
  const upper = (typeof cfg.upperC === 'number') ? cfg.upperC : Number(process.env.UPPER_BOUND_C ?? -70);
  const t = (typeof req.body?.t === 'number') ? req.body.t : (upper + 1);

  // set out of range logs for json response
  alerts.updateReading({ id, t, sr: 0, ts: Date.now(), lower, upper });
  res.json({ ok: true, sent: `Out-of-range for ${id} at ${t}°C (bounds ${lower}..${upper})` });
});

// Devices API (minimal)
app.get('/devices', adminAuth, async (_req, res) => {
  await ready;

  // set ids to new set object and map r to device id
  const ids = new Set(db.data.readings.map(r => r.device_id));
  //set object keys to db.datdevices ored with empty
  Object.keys(db.data.devices || {}).forEach(id => ids.add(id));

  // instantiate latestbyid
  const latestById = {};
  // for loop to iterate through db length from greatest to 0
  for (let i = db.data.readings.length - 1; i >= 0; i--) {
    //set r to db[index]
    const r = db.data.readings[i];
    // if false latest by id set the corresponding id to r
    if (!latestById[r.device_id]) latestById[r.device_id] = r;
  }

  // set out to map id to following fields
  const out = [...ids].map(id => ({
    id,
    cfg: (db.data.devices && db.data.devices[id]) || null,
    latest: latestById[id] || null,
  }));
  res.json({ devices: out });
});

// get devices id and set request and response to following variables
app.get('/devices/:id', adminAuth, async (req, res) => {
  await ready;
  const id = req.params.id;
  // config is set to devices to be anded with the devices[id] ored to be NULL
  const cfg = (db.data.devices && db.data.devices[id]) || null;
  //set latestRec to be db with reverse order and find corresponding record ORed to be null
  const latestRec = [...db.data.readings].reverse().find(r => r.device_id === id) || null;
  res.json({ id, cfg, latest: latestRec });
});

// put request and response
app.put('/devices/:id', adminAuth, async (req, res) => {
  await ready;
  const id = req.params.id;
  //set following fields to bode ored with empty string
  const { lowerC, upperC, name, notes } = req.body || {};

  // set cfg to db anded with db[id] ORed with nothing
  const cfg = (db.data.devices && db.data.devices[id]) || {};
  // set lowerC to check if not undefined and not same value or not same datatype
  if (lowerC !== undefined) {
    //check if type of lowerC is not the same as string or number ORed with number is finite
    if (typeof lowerC !== 'number' || !Number.isFinite(lowerC)) {
      return res.status(400).json({ error: 'lowerC must be a number' });
    }
    //set cfg lowerC to lowerC
    cfg.lowerC = lowerC;
  }
  // if upperC is not equal to undefined or datatype isn't
  if (upperC !== undefined) {
    // checks if upperc is not the same as number both in value and datatype
    if (typeof upperC !== 'number' || !Number.isFinite(upperC)) {
      // return error
      return res.status(400).json({ error: 'upperC must be a number' });
    }
    // set cfg upper to upperC
    cfg.upperC = upperC;
  }
  // check if name is not equal to undefined set the name to stringify name and slice based on index 0 to 80
  if (name !== undefined) cfg.name = String(name).slice(0, 80);
  // same as the last comment but for notes and 0 to 400
  if (notes !== undefined) cfg.notes = String(notes).slice(0, 400);

  // db is ored to set into field
  db.data.devices ||= {};
  // db[id] is set to cfg
  db.data.devices[id] = cfg;
  // await for db write
  await db.write();
  // response json set following fields
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
    // if n is finite, or  n less than -100 or greater than 50 return status 400 and send error message
    if (!Number.isFinite(n) || n < -100 || n >= 50) return res.status(400).json({ error: 'lowerC out of range' });
    // if true set lowerC to c
    cfg.lowerC = n;
  }
  // strict check if body upperC is not equal to undefined
  if (body.upperC !== undefined) {
    // set n to number in JS 64 bit upperc
    const n = Number(body.upperC);
    if (!Number.isFinite(n) || n <= -100 || n > 50) return res.status(400).json({ error: 'upperC out of range' });
    //set cfg upperc to n
    cfg.upperC = n;
  }
  // check if cfg lower c now equal to undefined anded with cfg.upper c not equal to undefined anded lowerc if greater than or equal upper c 
  if (cfg.lowerC !== undefined && cfg.upperC !== undefined && cfg.lowerC >= cfg.upperC) {
    return res.status(400).json({ error: 'lowerC must be < upperC' });
  }

  // Alerts master switch
  if (body.alerts_enabled !== undefined) {
    //val is set type of body alerts enable check if it is equal to string in value and datatype ternary statement if-else
    const val = (typeof body.alerts_enabled === 'string')
      ? ['1','true','on','yes'].includes(body.alerts_enabled.toLowerCase())
      : !!body.alerts_enabled;
      // set alerts enabled to val
    cfg.alerts_enabled = val;
  }

  // Per-channel toggles
  if (body.email_enabled !== undefined) {
    // set val to typeof body email enabled equal to string both in value and datatype
    const val = (typeof body.email_enabled === 'string')
      ? ['1','true','on','yes'].includes(body.email_enabled.toLowerCase())
      : !!body.email_enabled;
      // set cfg email enabled to val
    cfg.email_enabled = val;
  }
  // check if discord isn't enabled
  if (body.discord_enabled !== undefined) {
    //ternary statement
    const val = (typeof body.discord_enabled === 'string')
      ? ['1','true','on','yes'].includes(body.discord_enabled.toLowerCase())
      : !!body.discord_enabled;

      // set discord enabled value to val
    cfg.discord_enabled = val;
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
    // set to string of discord webhook url and trim it
    const s = String(body.discord_webhook_url).trim();
    // check s anded with not s to start with following string
    if (s && !s.startsWith('https://discord.com/api/webhooks/')) {
      // return a 400 status flag with following error code
      return res.status(400).json({ error: 'discord_webhook_url looks invalid' });
    }
    // set discord webhook url to string
    cfg.discord_webhook_url = s;
  }

  // check if discord thread id is equal to undefined and set discord thread id to equal string thread id trimmed
  if (body.discord_thread_id !== undefined) cfg.discord_thread_id = String(body.discord_thread_id).trim();
  // strict check if discord min gap sec is undefined
  if (body.discord_min_gap_sec !== undefined) {
    // set n to js number of body discord min gap sec 
    const n = Number(body.discord_min_gap_sec);
    // if number is finite ored with n less than 0 and n is greater than 3600 return error status flag
    if (!Number.isFinite(n) || n < 0 || n > 3600) return res.status(400).json({ error: 'discord_min_gap_sec invalid' });
    // set min gap sec to n
    cfg.discord_min_gap_sec = n;
  }

  // set db config to the cfg
  db.data.config = cfg;
  await db.write();
  // response .json build following fields
  res.json({ ok: true, config: cfg });
});

// database 
// post a config/reset, admin authenticate with response and request
app.post('/config/reset', adminAuth, async (_req, res) => {
  await ready;
  // set to empty field
  db.data.config = {};
  await db.write();
  // set response json to be true
  res.json({ ok: true });
});

// Admin UI
app.get('/admin', adminAuth, (_req, res) => {
  // set response to following strings
  res.set('Cache-Control', 'no-store');
  // response type send following html code
  res.type('html').send(`<!doctype html><meta charset="utf-8">
<title>Freezer Admin</title>
<style>
// set body font and system ui
  :root{--b:#ddd;--t:#222;--m:24px}
  body{font-family:system-ui,Segoe UI,Roboto,Apple Color Emoji,Noto Color Emoji;margin:var(--m);color:var(--t)}
  input,button{padding:.45rem .6rem;font:inherit}
  // set table, body and color and basic ui stuff
  table{border-collapse:collapse;margin-top:12px;width:100%}
  td,th{border:1px solid var(--b);padding:.45rem .6rem;text-align:left}
  .hint{color:#666;margin:.5rem 0}
  .pill{display:inline-block;padding:.15rem .45rem;border-radius:999px;border:1px solid var(--b);font-size:.85rem;cursor:pointer}
  .warn{margin-top:8px;padding:8px;border:1px dashed #f39;color:#b00;background:#fff4f6}
</style>
//header
<h1>Freezer Admin</h1>
// div for edit bounds
<div class="hint">Edit per-device bounds. Leave blank to use global env (${LOWER}…${UPPER} °C). Use Global Settings to set email recipients and/or Discord webhook.</div>
<div id="root">Loading…</div>
<script>
// javascript for website
// token set to new url object ored with none
const token = new URLSearchParams(location.search).get('token') || '';

// set q function to ternary statement
function q(v){ return v==null ? '' : v; }

// load function 
async function load(){
// set promise to fetch
  const [devRes, cfgRes] = await Promise.all([
    fetch('/devices'+(token?('?token='+encodeURIComponent(token)) : '')),
    fetch('/config'+(token?('?token='+encodeURIComponent(token)) : ''))
  ]);

  // await for following
  const dev = await devRes.json();
  const cfg = await cfgRes.json();
  const c = cfg.config || {};

  // set el to documet get element by id
  const el=document.getElementById('root');
  el.innerHTML = \`
  // html format
  <section style="margin:8px 0;padding:12px;border:1px solid var(--b);border-radius:8px">
    <h2 style="margin:0 0 8px 0">Global Settings</h2>
    <form id="globalForm" onsubmit="return saveConfig(event)">
      <div class="warn" id="alerts_warning" style="display:\${c.alerts_enabled ? 'none':'block'}">
        Alerts are <b>disabled</b>. No email or Discord messages will be sent until you enable them and set recipients.
      </div>
      <div style="margin:8px 0">
        <label style="display:inline-flex; gap:8px; align-items:center;">
          <input type="checkbox" name="alerts_enabled" id="alerts_enabled" \${c.alerts_enabled ? 'checked':''}>
          Enable alerts (Email + Discord)
        </label>
        // action buttons to interface over the following check boxes
        <label style="display:inline-flex; gap:8px; align-items:center; margin-left:16px;">
          <input type="checkbox" name="email_enabled"  id="email_enabled"  \${c.email_enabled ? 'checked':''}>
          Email channel
        </label>
        <label style="display:inline-flex; gap:8px; align-items:center; margin-left:16px;">
          <input type="checkbox" name="discord_enabled" id="discord_enabled" \${c.discord_enabled ? 'checked':''}>
          Discord channel
        </label>

      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
      // actionlisteners for lower and upper bounds
        <label>Default Lower (°C): <input name="lowerC" type="number" step="0.1" value="\${q(c.lowerC)}"></label>
        <label>Default Upper (°C): <input name="upperC" type="number" step="0.1" value="\${q(c.upperC)}"></label>
        <label>Alert To (comma-separated emails): <input name="alert_to_email" placeholder="e.g. alice@example.com,bob@lab.org" value="\${q(c.alert_to_email)}"></label>
      </div>
      // for input text boxes
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
        <label>Discord Webhook URL: <input name="discord_webhook_url" style="min-width:420px" placeholder="https://discord.com/api/webhooks/..." value="\${q(c.discord_webhook_url)}"></label>
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

      // set following values to ship across the internet to server
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

          // submit button
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

// save device function
async function saveDevice(ev,id){
  ev.preventDefault();
  // set f to new formdata
  const f=new FormData(ev.target);
  // set body to empty instance
  const body={};

  // for loop to iterate through entries
  for(const [k,v] of f.entries()){
    if(k==='lowerC'||k==='upperC'){ if(v!=='') body[k]=Number(v); }
    else if(k==='name'){ body[k]=v; }
  }
    // set r to fetch
  const r=await fetch('/devices/'+encodeURIComponent(id)+(token?('?token='+encodeURIComponent(token)):''),{
    method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
  });
  // check if r ok field fale then error message
  if(!r.ok){alert('Save failed: '+await r.text());return false;}
  load(); return false;
}


// save config function
async function saveConfig(ev){
  ev.preventDefault();
  const f = new FormData(ev.target);
  const body = {};
  // always send alerts_enabled
  body.alerts_enabled = !!document.getElementById('alerts_enabled')?.checked;
  body.email_enabled   = !!document.getElementById('email_enabled')?.checked;
  body.discord_enabled = !!document.getElementById('discord_enabled')?.checked;
  // set for loop to iterate through f entries
  for (const [k,v] of f.entries()) {
  // if statements to go continue and else to set body[k] to v
    if (k==='alerts_enabled' || k==='email_enabled' || k==='discord_enabled') continue; // handled above
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

// set reset config function
async function resetConfig(){
  if (!confirm('Reset ALL global settings to defaults from .env?')) return;
  const r = await fetch('/config/reset'+(token?('?token='+encodeURIComponent(token)) : ''), { method:'POST' });
  if (!r.ok) { alert('Reset failed: '+await r.text()); return; }
  load();
}

//function to test alert
async function testAlert(){
  const r = await fetch('/_test/alert', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
  if (!r.ok) { alert('Test failed: '+await r.text()); return; }
  alert('Test alert queued. Check your phone/email and Discord.');
}

//function reset device
async function resetDevice(id){
  if (!confirm('Reset overrides for device '+id+'?')) return;
  const r = await fetch('/devices/'+encodeURIComponent(id)+'/reset'+(token?('?token='+encodeURIComponent(token)) : ''), { method:'POST' });
  if (!r.ok) { alert('Device reset failed: '+await r.text()); return; }
  load();
}

// call load
load();
</script>`);
});

// Error handler (minimal)
app.use((err, _req, res, _next) => {
  const code = err?.status || 500;
  res.status(code).json({ error: err?.message || 'internal_error' });
});

// display logs
ready.then(() => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
  console.log(`Bounds: LOWER=${LOWER} UPPER=${UPPER}`);
  console.log(`Dedup: Δ≥${DEDUP_DELTA_C}°C, heartbeat=${KEEPALIVE_MS / 1000}s`);
  app.listen(PORT, '0.0.0.0');
});

// shut down
process.on('SIGTERM', () => {
  console.log('Shutting down…');
  process.exit(0);
});
