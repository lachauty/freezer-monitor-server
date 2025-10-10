// alerts.js
// SMTP email (including email-to-SMS/MMS) + alert state machine + cooldown + offline detection

const nodemailer = require("nodemailer");

// Env knobs (with fallback defaults)
const LOWER = Number(process.env.LOWER_BOUND_C ?? -90);
const UPPER = Number(process.env.UPPER_BOUND_C ?? -70);
const HEARTBEAT_SEC = Number(process.env.HEARTBEAT_SEC ?? (Number(process.env.KEEPALIVE_MS ?? 300000) / 1000));
const COOLDOWN_SEC = Number(process.env.ALERT_COOLDOWN_SEC ?? 900);
const SPIKE_C = Number(process.env.SPIKE_C ?? 1.5);

const emailList = (process.env.ALERT_TO_EMAIL || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const smtpEnabled =
  !!process.env.SMTP_HOST && !!process.env.SMTP_USER && !!process.env.SMTP_PASS && emailList.length > 0;

const smtp = smtpEnabled ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
}) : null;

// State per device
// id -> { lastTs, lastTemp, lastSr, status: 'normal'|'alert'|'offline'|'fault', lastAlertAt: {key: ts}, lastOnlineAt }
const devices = new Map();

// Utility for cooldown buckets
function shouldCooldown(state, key, now) {
  const lastAt = state.lastAlertAt?.[key] || 0;
  if (now - lastAt >= COOLDOWN_SEC * 1000) {
    state.lastAlertAt = state.lastAlertAt || {};
    state.lastAlertAt[key] = now;
    return false; // NOT cooling down: allowed to send
  }
  return true; // within cooldown window
}


function fmtBounds() {
  return `${LOWER}…${UPPER} °C`;
}

async function sendEmail({ subject, text }) {
  if (!smtpEnabled) {
    console.log("(email dry-run)", subject, text);
    return;
  }

  try {
    await smtp.sendMail({
      from: process.env.ALERT_FROM_EMAIL || process.env.SMTP_USER,
      to: emailList,
      subject,
      text
    });
  } catch (e) {
    console.warn("SMTP send error:", e?.message || e);
  }
}

function createAlertManager() {
  let notifier = null; // (evt) => void|Promise<void>
  function getStates() {
    return [...devices.entries()].map(([id, s]) => ({ id, ...s }));
  }

  function setNotifier(fn) {
    notifier = fn;
  }

  // Normalize & fan-out an event to email + optional notifier (e.g., Discord)
  async function emitEvent(evt) {
    // evt: { kind, id, t, lower, upper, when }
    const when = evt.when || new Date().toISOString();
    const lower = evt.lower ?? LOWER;
    const upper = evt.upper ?? UPPER;

    let subject, text;

    switch (evt.kind) {
      case 'alert':
        subject = `🚨 ${evt.id} out of range: ${evt.t}°C (bounds ${lower}..${upper})`;
        text = `[${when}] ALERT: ${evt.id} at ${evt.t}°C (bounds ${lower}..${upper})`;
        break;
      case 'recover':
        subject = `✅ ${evt.id} recovered: ${evt.t}°C within bounds`;
        text = `[${when}] RECOVERED: ${evt.id} at ${evt.t}°C within bounds ${lower}..${upper}`;
        break;
      case 'fault':
        subject = `⚠️ ${evt.id} sensor fault (sr=0x${(evt.sr >>> 0).toString(16)})`;
        text = `[${when}] FAULT: ${evt.id} status=0x${(evt.sr >>> 0).toString(16)}`;
        break;
      case 'offline':
        subject = `❌ ${evt.id} offline (no data)`;
        text = `[${when}] OFFLINE: ${evt.id} missed heartbeats`;
        break;
      case 'online':
        subject = `🟢 ${evt.id} back online`;
        text = `[${when}] ONLINE: ${evt.id} resumed sending data`;
        break;
      case 'heartbeat':
      default:
        subject = `ℹ️ ${evt.id} heartbeat`;
        text = `[${when}] HEARTBEAT: ${evt.id} t=${evt.t ?? '—'}°C`;
        break;
    }

    // Email path
    await sendEmail({ subject, text });

    // Discord (or other) path
    if (typeof notifier === 'function') {
      try { await notifier({ ...evt, lower, upper, when }); }
      catch (e) { console.warn("Notifier error:", e); }
    }
  }

  function updateReading({ id, t, sr = 0, ts = Date.now(), lower, upper }) {
    const now = ts;
    const rec = devices.get(id) || {
      lastTs: 0,
      lastTemp: undefined,
      lastSr: 0,
      status: 'normal',
      lastAlertAt: {},
      lastOnlineAt: 0,
    };

    const wasStatus = rec.status;
    const wasOffline = (wasStatus === 'offline');

    // Basic fault flag check: any non-zero SR considered "fault"
    const faultNow = (sr >>> 0) !== 0;

    const lowerNow = (typeof lower === 'number') ? lower : LOWER;
    const upperNow = (typeof upper === 'number') ? upper : UPPER;

    // Determine current status based on temp & fault
    let statusNow = 'normal';
    if (faultNow) statusNow = 'fault';
    else if (typeof t === 'number' && (t < lowerNow || t > upperNow)) statusNow = 'alert';

    // If previously offline and data now arrived, flip to online (one-time notification)
    if (wasOffline) {
      // Cooldown for 'online' is separate key
      if (!shouldCooldown(rec, 'online', now)) {
        emitEvent({ kind: 'online', id, t, sr, lower: lowerNow, upper: upperNow, when: new Date(now).toISOString() });
      }
    }

    // Fault transition handling (immediate)
    if (statusNow === 'fault') {
      if (!shouldCooldown(rec, 'fault', now) || wasStatus !== 'fault') {
        emitEvent({ kind: 'fault', id, t, sr, lower: lowerNow, upper: upperNow, when: new Date(now).toISOString() });
      }
    }

    // Alert / recover handling
    const wasAlert = wasStatus === 'alert';
    const nowAlert = statusNow === 'alert';
    if (nowAlert) {
      // Reduce noise: large spikes trigger immediate, otherwise respect cooldown
      const spike = (Number.isFinite(rec.lastTemp) && Math.abs(t - rec.lastTemp) >= SPIKE_C);
      const key = 'alert';
      if (spike || !shouldCooldown(rec, key, now) || !wasAlert) {
        emitEvent({ kind: 'alert', id, t, lower: lowerNow, upper: upperNow, when: new Date(now).toISOString() });
      }
    } else if (wasAlert && statusNow === 'normal') {
      // back in range
      if (!shouldCooldown(rec, 'recover', now)) {
        emitEvent({ kind: 'recover', id, t, lower: lowerNow, upper: upperNow, when: new Date(now).toISOString() });
      }
    }

    // Persist device state
    rec.lastTs = now;
    rec.lastTemp = t;
    rec.lastSr = sr >>> 0;
    rec.status = statusNow;
    rec.lastOnlineAt = now;
    devices.set(id, rec);
  }

  // Called periodically by server.js
  function checkHeartbeats() {
    const now = Date.now();
    const offlineAfterMs = Math.max(30, HEARTBEAT_SEC) * 1000 * 2; // ~2× heartbeat as "offline"

    for (const [id, rec] of devices.entries()) {
      const since = now - (rec.lastTs || 0);
      const isOffline = since >= offlineAfterMs;

      if (isOffline && rec.status !== 'offline') {
        // Transition to offline (with cooldown)
        if (!shouldCooldown(rec, 'offline', now)) {
          emitEvent({ kind: 'offline', id, when: new Date(now).toISOString() });
        }
        rec.status = 'offline';
        devices.set(id, rec);
      }
    }
  }

  return {
    updateReading,
    checkHeartbeats,
    setNotifier,
    getStates,
  };
}

module.exports = { createAlertManager };
