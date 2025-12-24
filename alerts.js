// alerts.js
// builds an Alert Manager to track per-device state such as the temperature
// last recorded log time, and fault flags such as normal, alert, offline, online, or heartbeat.
// The alert manager decides when to emit events such as when to alert for recovery, offline
// and heartbeat/out of set temperature range.
// Alerts such as SMTP, Resend (service for HTTPS to Email), and Discord Channel notifiers. 
// Prevents spam using cooldowns, spike detection, and offline detection.


// Provider selection
// 1) smtp
// 2) Resend
// 3) SendGrid (optional)
const EMAIL_PROVIDER = (process.env.EMAIL_PROVIDER || 'smtp').toLowerCase();
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || '';


const nodemailer = require("nodemailer");
// SMTP transport creation
// creates a nodemailer transport if required environment variables (stored in .env file) exist
const smtpEnvReady =
  !!process.env.SMTP_HOST && !!process.env.SMTP_USER && !!process.env.SMTP_PASS;
// secure is set if SMTP_SECURE is set (True)
// if not SMTP is NULL and later code skips SMTP sending
  const smtp = smtpEnvReady
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: String(process.env.SMTP_SECURE).toLowerCase() === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

// "Knobs" for behavior -> Tunes/adjusts parameters for how the program runs
// Heartbeat knob -> We expect 300000ms or 300 sec of logging
const HEARTBEAT_SEC = Number(
  process.env.HEARTBEAT_SEC ??
    (Number(process.env.KEEPALIVE_MS ?? 300000) / 1000)
);
// Alert cooldown knob -> prevents spamming alerts, and we expect 900/60 ~ 15 minutes of relief
const COOLDOWN_SEC = Number(process.env.ALERT_COOLDOWN_SEC ?? 900);
// Spike cooldown knob -> expects a massive delta > 1.5 temperature reading to send alerts if out of set temperature range
const SPIKE_C = Number(process.env.SPIKE_C ?? 1.5);

// getConfig is a function variable that returns an empty object
let getConfig = () => ({});
function setConfigGetter(fn) {
  if (typeof fn === "function") getConfig = fn;
}

// State per device 
const devices = new Map();

// Utility for cooldown function
function shouldCooldown(state, key, now) {
  const lastAt = state.lastAlertAt?.[key] || 0;

  // checks the current time subtracted by the last recorded measurement
  // to be greater than or equal to the cool down time
  if (now - lastAt >= COOLDOWN_SEC * 1000) {
    //sets last alert to the next recorded alert
    state.lastAlertAt = state.lastAlertAt || {};
    state.lastAlertAt[key] = now;
    return false;
  }
  return true;
}

// Function for Parsing email detail
function parseRecipients(s) {
  if (!s) return [];
  return String(s)
    .split(/[,\s;]+/)
    .map(x => x.trim())
    .filter(Boolean);
}

// asynchronous sleep function to call
async function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
// 
async function withRetries(fn, { tries=2, baseMs=600 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await fn();
    if (last && last.ok) return last;
    await sleep(baseMs * Math.pow(2, i) + Math.floor(Math.random()*120));
  }
  return last || { ok: false };
}

async function sendEmail({ subject, text, html, to }) {
  try {
    // Pull runtime config (from DB via server.js)
    const cfg = getConfig() || {};
    const alertsEnabled = !!cfg.alerts_enabled;
    const emailEnabled  = cfg.email_enabled !== undefined ? !!cfg.email_enabled : true;

    if (!alertsEnabled || !emailEnabled) {
      return { ok: false, skipped: true, reason: 'email disabled in config' };
    }

    // Recipients: explicit 'to' wins; else config; else env fallback
    let recipients = [];
    if (to) {
      recipients = Array.isArray(to) ? to : [to];
    } else {
      recipients = parseRecipients(cfg.alert_to_email || process.env.ALERT_TO_EMAIL || '');
    }
    if (recipients.length === 0) {
      return { ok: false, skipped: true, reason: 'no recipients configured' };
    }

    const fromAddr =
      (cfg.alert_from_email && String(cfg.alert_from_email).trim()) ||
      process.env.ALERT_FROM_EMAIL ||
      process.env.SMTP_USER ||
      'alerts@example.com';

    const provider = (process.env.EMAIL_PROVIDER || 'smtp').toLowerCase();

    // Provider: RESEND
    if (provider === 'resend') {
      const apiKey = process.env.RESEND_API_KEY || '';
      if (!apiKey) return { ok: false, skipped: true, reason: 'missing RESEND_API_KEY' };

      const fn = async () => {
        try {
          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), 20000); // 20s cap
          const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              from: fromAddr,
              to: recipients,
              subject,
              text,
              html
            }),
            signal: controller.signal
          }).finally(() => clearTimeout(t));

          if (!res || !res.ok) {
            const body = res ? await res.text().catch(()=> '') : '';
            console.warn('Resend email HTTP err:', res?.status, body);
            return { ok: false };
          }
          const data = await res.json().catch(()=> ({}));
          return { ok: true, id: data.id };
        } catch (e) {
          console.warn('Resend email network error:', e?.message || e);
          return { ok: false };
        }
      };

      return await withRetries(fn, { tries: 2, baseMs: 700 });
    }

    // Provider: SENDGRID
    if (provider === 'sendgrid') {
      const sgKey = process.env.SENDGRID_API_KEY || '';
      if (!sgKey) return { ok: false, skipped: true, reason: 'missing SENDGRID_API_KEY' };

      const fn = async () => {
        try {
          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), 20000);
          const payload = {
            personalizations: [{ to: recipients.map(e => ({ email: e })) }],
            from: { email: fromAddr },
            subject,
            content: [{ type: html ? 'text/html' : 'text/plain', value: html || text || '' }]
          };
          const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${sgKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload),
            signal: controller.signal
          }).finally(() => clearTimeout(t));

          if (!res || (res.status !== 202 && !res.ok)) {
            const body = res ? await res.text().catch(()=> '') : '';
            console.warn('SendGrid email HTTP err:', res?.status, body);
            return { ok: false };
          }
          return { ok: true };
        } catch (e) {
          console.warn('SendGrid email network error:', e?.message || e);
          return { ok: false };
        }
      };

      return await withRetries(fn, { tries: 2, baseMs: 700 });
    }

    // Provider: SMTP (nodemailer)
    if (provider === 'smtp') {
      if (!smtpEnvReady || !smtp) {
        return { ok: false, skipped: true, reason: 'SMTP_* env missing' };
      }
      try {
        const info = await smtp.sendMail({
          from: fromAddr,
          to: recipients.join(','),
          subject,
          text: text || (html ? undefined : '(no body)'),
          html
        });
        if (!info || !info.accepted || info.accepted.length === 0) {
          console.warn('SMTP did not accept any recipients:', info);
          return { ok: false };
        }
        return { ok: true, id: info.messageId };
      } catch (e) {
        console.warn('SMTP send error:', e?.message || e);
        return { ok: false };
      }
    }

    // Unknown provider
    return { ok: false, skipped: true, reason: `unknown provider ${provider}` };
  } catch (e) {
    console.warn('Email send exception:', e);
    return { ok: false };
  }
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
