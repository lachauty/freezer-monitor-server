// alerts.js
// Email via SMTP only (no Brevo, no SMS) + alert state machine + cooldown + offline detection

// --- Fallback: SMTP (optional) ---
const nodemailer = require("nodemailer");
const smtpEnvReady =
  !!process.env.SMTP_HOST && !!process.env.SMTP_USER && !!process.env.SMTP_PASS;
const smtp = smtpEnvReady
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: String(process.env.SMTP_SECURE).toLowerCase() === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

// Heartbeat/cooldown/spike knobs
const HEARTBEAT_SEC = Number(
  process.env.HEARTBEAT_SEC ??
    (Number(process.env.KEEPALIVE_MS ?? 300000) / 1000)
);
const COOLDOWN_SEC = Number(process.env.ALERT_COOLDOWN_SEC ?? 900);
const SPIKE_C = Number(process.env.SPIKE_C ?? 1.5);

let getConfig = () => ({});
function setConfigGetter(fn) {
  if (typeof fn === "function") getConfig = fn;
}

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

async function sendEmail({ subject, text }) {
  const cfg = getConfig() || {};
  
  if (!cfg.alerts_enabled) { console.log("(alerts disabled)", subject); return; }
  if (!cfg.email_enabled)  { console.log("(email disabled)", subject);  return; }

  // Recipients: use DB-configured list only
  const configuredTo = (cfg.alert_to_email || "").trim();
  const toList = configuredTo.split(",").map((s) => s.trim()).filter(Boolean);

  if (toList.length === 0) {
    console.log("(email dry-run: no recipients)", { subject });
    return;
  }

  const fromEmail =
    cfg.alert_from_email ||
    process.env.ALERT_FROM_EMAIL || // optional global default
    process.env.SMTP_USER;          // fallback to SMTP user

  // --- SMTP send (only path) ---
  if (smtp) {
    try {
      await smtp.sendMail({
        from: fromEmail,
        to: toList,
        subject,
        text,
      });
      console.log("SMTP send ok");
    } catch (e) {
      console.warn("SMTP send error:", e?.message || e);
    }
    return;
  }

  console.log("(email dry-run: no SMTP config)", subject);
}

// Normalize & fan-out an event to email + optional notifier (e.g., Discord)
async function emitEvent(evt) {
  // evt: { kind, id, t, lower, upper, when, sr }
  const when = evt.when || new Date().toISOString();
  const lower = evt.lower;
  const upper = evt.upper;

  let subject, text;

  switch (evt.kind) {
    case "alert":
      subject = `🚨 ${evt.id} out of range: ${evt.t}°C (bounds ${lower}..${upper})`;
      text = `[${when}] ALERT: ${evt.id} at ${evt.t}°C (bounds ${lower}..${upper})`;
      break;
    case "recover":
      subject = `✅ ${evt.id} recovered: ${evt.t}°C within bounds`;
      text = `[${when}] RECOVERED: ${evt.id} at ${evt.t}°C within bounds ${lower}..${upper})`;
      break;
    case "fault":
      subject = `⚠️ ${evt.id} sensor fault (sr=0x${(evt.sr >>> 0).toString(
        16
      )})`;
      text = `[${when}] FAULT: ${evt.id} status=0x${(evt.sr >>> 0).toString(
        16
      )}`;
      break;
    case "offline":
      subject = `❌ ${evt.id} offline (no data)`;
      text = `[${when}] OFFLINE: ${evt.id} missed heartbeats`;
      break;
    case "online":
      subject = `🟢 ${evt.id} back online`;
      text = `[${when}] ONLINE: ${evt.id} resumed sending data`;
      break;
    case "heartbeat":
    default:
      subject = `ℹ️ ${evt.id} heartbeat`;
      text = `[${when}] HEARTBEAT: ${evt.id} t=${evt.t ?? "—"}°C`;
      break;
  }

  // Email path
  await sendEmail({ subject, text });

  // Discord (or other) path
  if (typeof notifier === "function") {
    try {
      await notifier({ ...evt, lower, upper, when });
    } catch (e) {
      console.warn("Notifier error:", e);
    }
  }
}

let notifier = null; // (evt) => void|Promise<void>
function setNotifier(fn) {
  notifier = fn;
}

function updateReading({ id, t, sr = 0, ts = Date.now(), lower, upper }) {
  const now = ts;
  const rec =
    devices.get(id) || {
      lastTs: 0,
      lastTemp: undefined,
      lastSr: 0,
      status: "normal",
      lastAlertAt: {},
      lastOnlineAt: 0,
    };

  const wasStatus = rec.status;
  const wasOffline = wasStatus === "offline";

  // Basic fault flag check: any non-zero SR considered "fault"
  const faultNow = (sr >>> 0) !== 0;

  const lowerNow = lower;
  const upperNow = upper;

  // Determine current status based on temp & fault
  let statusNow = "normal";
  if (faultNow) statusNow = "fault";
  else if (typeof t === "number" && (t < lowerNow || t > upperNow))
    statusNow = "alert";

  // If previously offline and data now arrived, flip to online (one-time notification)
  if (wasOffline) {
    if (!shouldCooldown(rec, "online", now)) {
      emitEvent({
        kind: "online",
        id,
        t,
        sr,
        lower: lowerNow,
        upper: upperNow,
        when: new Date(now).toISOString(),
      });
    }
  }

  // Fault transition handling (immediate)
  if (statusNow === "fault") {
    if (!shouldCooldown(rec, "fault", now) || wasStatus !== "fault") {
      emitEvent({
        kind: "fault",
        id,
        t,
        sr,
        lower: lowerNow,
        upper: upperNow,
        when: new Date(now).toISOString(),
      });
    }
  }

  // Alert / recover handling
  const wasAlert = wasStatus === "alert";
  const nowAlert = statusNow === "alert";
  if (nowAlert) {
    // Reduce noise: large spikes trigger immediate, otherwise respect cooldown
    const spike =
      Number.isFinite(rec.lastTemp) && Math.abs(t - rec.lastTemp) >= SPIKE_C;
    const key = "alert";
    if (spike || !shouldCooldown(rec, key, now) || !wasAlert) {
      emitEvent({
        kind: "alert",
        id,
        t,
        lower: lowerNow,
        upper: upperNow,
        when: new Date(now).toISOString(),
      });
    }
  } else if (wasAlert && statusNow === "normal") {
    // back in range
    if (!shouldCooldown(rec, "recover", now)) {
      emitEvent({
        kind: "recover",
        id,
        t,
        lower: lowerNow,
        upper: upperNow,
        when: new Date(now).toISOString(),
      });
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

    if (isOffline && rec.status !== "offline") {
      if (!shouldCooldown(rec, "offline", now)) {
        emitEvent({
          kind: "offline",
          id,
          when: new Date(now).toISOString(),
        });
      }
      rec.status = "offline";
      devices.set(id, rec);
    }
  }
}

function getStates() {
  return [...devices.entries()].map(([id, s]) => ({ id, ...s }));
}

function createAlertManager() {
  return {
    updateReading,
    checkHeartbeats,
    setNotifier,
    getStates,
  };
}

module.exports = { createAlertManager, setConfigGetter };
