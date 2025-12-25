// alerts.js
// builds an Alert Manager to track per-device state such as the temperature
// last recorded log time, and fault flags such as normal, alert, offline, online, or heartbeat.
// The alert manager decides when to emit events such as when to alert for recovery, offline
// and heartbeat or out of set temperature range.
// Alerts such as SMTP, Resend (service for HTTPS to Email), and Discord Channel notifiers. 
// Prevents spam using cooldowns, spike detection, and offline detection.


// Provider selection
// 1) smtp
// 2) Resend
// 3) SendGrid (optional)
const EMAIL_PROVIDER = (process.env.EMAIL_PROVIDER || 'smtp').toLowerCase();
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || '';


// nodemailer is a popular node.js library that allows javascript
// server code to send emails -> it essentially handles the backend of sending emails.
const nodemailer = require("nodemailer");
// SMTP transport creation
// creates a nodemailer transport if required environment variables (stored in .env file) exist
// const variable where we check if SMTP host, user, or password exists in .env file
const smtpEnvReady =

// !! is a double-bang operator -> This essentially checks if the boolean value is actually legitimate

  !!process.env.SMTP_HOST && 
  !!process.env.SMTP_USER && 
  !!process.env.SMTP_PASS;
// secure is set if SMTP_SECURE is set (True)
// if not SMTP is NULL and later code skips SMTP sending
// 587 is a port number for application level gateways -> think of things like outlook or gmail
// it acts like a entrance for transport layer security
//TERNARY EXPRESSION
const smtp = smtpEnvReady
  ? nodemailer.createTransport({
    // we populate fields such as SMTP host from the .env file
      host: process.env.SMTP_HOST,

      // ?? is a nullish coalescing operator, it means that it checks if the value in the .env file is null or not
      
      // if the SMTP_port .env is NULL, then use port 587
      port: Number(process.env.SMTP_PORT ?? 587),
      // There are 2 different ways to encrypt SMTP
      // if secure is true ->  port 465 style (TLS)
      // this means encryption starts before any data is sent
      // it's like when you try to enter your house but you don't have your house keys
      // if secure is false -> port 587 style (STARTTLS)
      // this means, we can enter the house without the keys, but we lock the door behind us
      secure: String(process.env.SMTP_SECURE).toLowerCase() === "true",
      // this is essentially setting up authentication for user email and password
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

// "Knobs" for behavior -> Tunes/adjusts parameters for how the program runs
// Heartbeat knob -> We expect 300000ms or 300 sec of logging
const HEARTBEAT_SEC = Number(
  process.env.HEARTBEAT_SEC ??
  // Number() is essentially a javascript command/keyword that converts
  // the value of a variable or constant into a javascript defined floating point -> (IEEE-754)
  // IEEE-754 is a universal standard for representing and performing arithmetic on floating-point numbers

  // Further explanation for IEEE-754
  // 1 bit is the sign bit, 8 bits is the exponential to multiply by base 10, 23 bits is the fraction mantissa
  // 5.75 -> split fraction and whole number -> 5 + 0.75
  // converting 0.75 to base 2 -> 0.75 x 2 = 1.5 -> 0.5 x 2 = 1.0 -> 0.11
  // converting 5 to base 2 -> 5/2 = (2 r1) -> 2/2 = (1 r0) -> 1/2 = (0 r1) -> 0/2 = (0 r0) (reverse remainder order) = 0101
  // 5 -> 0101, 0.75 -> 0.11
    (Number(process.env.KEEPALIVE_MS ?? 300000) / 1000)
);
// Alert cooldown knob -> prevents spamming alerts, and we expect 900/60 ~ 15 minutes of relief
const COOLDOWN_SEC = Number(process.env.ALERT_COOLDOWN_SEC ?? 900);
// Spike cooldown knob -> expects a massive delta > 1.5 temperature reading to send alerts if out of set temperature range
const SPIKE_C = Number(process.env.SPIKE_C ?? 1.5);

// getConfig is a function variable that returns an empty object
let getConfig = () => ({});
// function with parameter name fn
function setConfigGetter(fn) {
  // "===" -> strict check if fn are equal in value and datatype to "function"
  // typeof in JavaScript is a unary operator that returns a string of a variable's datatype
  // sets get config to fn if true
  if (typeof fn === "function") getConfig = fn;
}

// Map() is a JavaScript Class that stores key-value pairs.
// new is a keyword that creates a new object.
// devices is a variable that points to the Map() object.
const devices = new Map();

// Utility for cooldown function
// function takes in a state, a key, and the current time
function shouldCooldown(state, key, now) {

  // ?. is an optional chaining operator in JavaScript
  // used for safely accessing properties of an object that could be null or undefined
  // without creating an error

  // if state.lastAlertAt doesnt exist, set to 0
  // key is the type of alert
  // set lastAt as state.lastAlertAt and if it doesn't exist set to 0
  const lastAt = state.lastAlertAt?.[key] || 0;

  // checks for the delta time from the time the last alert was triggered
  // to be greater than or equal to the cool down time
  // multiply 1000 because of millisecond
  if (now - lastAt >= COOLDOWN_SEC * 1000) {
    // sets last alert to the next recorded alert or empty
    state.lastAlertAt = state.lastAlertAt || {};
    // set last alert to current time
    state.lastAlertAt[key] = now;
    return false;
  }
  return true;
}

// Function for Parsing email detail
// takes in s as a parameter of any type
function parseRecipients(s) {
  // if s exists return empty
  if (!s) return [];
  // return the string as formatted
  return String(s)
  // split based on comma, whitespace, semicolon (one or more in the line)
    .split(/[,\s;]+/)
    // map is an array method
    // set x to trim spaces at the start and end to all of x
    .map(x => x.trim())
    // keep only truthy values
    // falsey values are things like "", undefined, null, 0, false, NaN
    .filter(Boolean);
}

// asynchronous sleep function with millisecond parameter
async function sleep(ms){ 
  // a promise represents a value that will be available later
  // setTimeout is a command that waits based on ms and calls r() to resolve its promise
  return new Promise(r => setTimeout(r, ms)); 
}

// asynchronous retry function with fn as a parameter
// { tries=2, baseMs=600 } = {} is a destructured options object
// default values tries=2, baseMs=600, if caller doesn't pass any options, leave empty
async function withRetries(fn, { tries=2, baseMs=600 } = {}) {
  // last will store last result
  let last;
  // for loop to iterate from 0 to the number of tries
  for (let i = 0; i < tries; i++) {
    // set last to function
    last = await fn();
    // if statement to check if last ANDed last.ok, return last if true
    if (last && last.ok) return last;
    // wait for sleep if fail -> sleep is a backoff delay
    // baseMS x 2^i + random jitters
    // we add random jitters to avoid servers retrying at the same time
    await sleep(baseMs * Math.pow(2, i) + Math.floor(Math.random()*120));
  }
  // return last or ok
  return last || { ok: false };
}


// asynchronous function for sending emails with parameters subject, text, html, and to
async function sendEmail({ subject, text, html, to }) {
  // try
  try {
    // we set the config to our getter function
    const cfg = getConfig() || {};
    // check if alerts are enabled
    const alertsEnabled = !!cfg.alerts_enabled;
    // check if emailEnabled is not equal to undefined for both value and datatype
    // ternary expression that if email_enabled is defined, validate it, else true
    const emailEnabled = cfg.email_enabled !== undefined ? !!cfg.email_enabled : true;

    // if statement checking if alerts or email isn't enabled
    if (!alertsEnabled || !emailEnabled) {
      // return an object with populated fields, ok: false, skipped: true, reason: 'email disabled in config'
      return { ok: false, skipped: true, reason: 'email disabled in config' };
    }

    // initialize recipients to be empty
    let recipients = [];
    // check if to exists
    if (to) {
      // true -> check for "to" if it is an array and set recipients a "to" array, else set it to "to"
      recipients = Array.isArray(to) ? to : [to];
    } 
    else {
      // parseRecipients to recipients with alert_to_email, or .env, or nothing
      recipients = parseRecipients(cfg.alert_to_email || process.env.ALERT_TO_EMAIL || '');
    }
    // if recipient length is equal to 0 both in value and datatype
    if (recipients.length === 0) {
      // return the populated fields for ok -> false, skipped -> true, reason -> 'no recipients configured'
      return { ok: false, skipped: true, reason: 'no recipients configured' };
    }

    // sets the from address to the from email via .env file
    const fromAddr =
      (cfg.alert_from_email && String(cfg.alert_from_email).trim()) ||
      process.env.ALERT_FROM_EMAIL ||
      process.env.SMTP_USER ||
      'alerts@example.com';

    // provider is set .env file email or smtp and lower casify it
    const provider = (process.env.EMAIL_PROVIDER || 'smtp').toLowerCase();

    // checks if the provider is equal to the value and its datatype
    if (provider === 'resend') {
      // set api key or none
      const apiKey = process.env.RESEND_API_KEY || '';
      // checks if apikey is nonexistent, set populated fields
      if (!apiKey) return { ok: false, skipped: true, reason: 'missing RESEND_API_KEY' };

      // fn is set to be an async function
      const fn = async () => {
        //try
        try {
          // AbortController is a built-in browser / Node API that let's us start async operation
          // and cancel whenever we want
          // set controller to a new object under the AbortController class
          const controller = new AbortController();
          // set timeout with controller to abort, with 20 sec cap
          const t = setTimeout(() => controller.abort(), 20000);
          // set res to await and fetch the resend api email calls
          const res = await fetch('https://api.resend.com/emails', {
            // populated fields
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

          // checks for if resend exists or if populated ok exists
          if (!res || !res.ok) {
            // if resend exists catch the text else leave empty
            const body = res ? await res.text().catch(()=> '') : '';
            // issue warning error with res and an optional status with body
            console.warn('Resend email HTTP err:', res?.status, body);
            // populate ok field
            return { ok: false };
          }
          // set data to await for resend json file to catch in empty field
          const data = await res.json().catch(()=> ({}));
          // return ok field, and id field
          return { ok: true, id: data.id };
        }
        // error catch 
        catch (e) {
          // issue error warning for email network with optional message or error
          console.warn('Resend email network error:', e?.message || e);
          // populate ok field
          return { ok: false };
        }
      };

      // return to await for retry function with following fn and default fields
      return await withRetries(fn, { tries: 2, baseMs: 700 });
    }

    // Provider -> SMTP (nodemailer)
    if (provider === 'smtp') {
      // we check for SMTP .env and if smtp exists
      if (!smtpEnvReady || !smtp) {
        // return the following fields if failure
        return { ok: false, skipped: true, reason: 'SMTP_* env missing' };
      }
      try {
        // try to send an email with the following fields
        const info = await smtp.sendMail({
          from: fromAddr,
          to: recipients.join(','),
          subject,
          text: text || (html ? undefined : '(no body)'),
          html
        });
        // if info does not exist or the accepted field failed, or it length != 0
        //error handle
        if (!info || !info.accepted || info.accepted.length === 0) {
          console.warn('SMTP did not accept any recipients:', info);
          return { ok: false };
        }
        return { ok: true, id: info.messageId };
      }
      //catch error 
      catch (e) {
        // send error message
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

  // switch statement for different event types such as when
  // temperature is out of set range, in recovery, a sensor fault,
  // offline, back online, and heartbeat temperature recording.
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

  // we await to send an email with subject and the text
  await sendEmail({ subject, text });

  // Discord 
  // check notifier for datatype and value
  if (typeof notifier === "function") {
    try {
      // await for the notifier with the populated fields
      await notifier({ ...evt, lower, upper, when });
    } 
    catch (e) {
      // notifier error
      console.warn("Notifier error:", e);
    }
  }
}

// notifier is instantiate to be set as null
// setnotifier is a setter to set notifier
let notifier = null;
function setNotifier(fn) {
  notifier = fn;
}

// updater helper function for temperature readings
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

  // update wasStatus and wasOffline
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

  // If previously offline and data now arrived, flip to online 
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

  // Fault transition handling
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
  
  // for loop to loop through id, record of device entries
  for (const [id, rec] of devices.entries()) {
    const since = now - (rec.lastTs || 0);
    const isOffline = since >= offlineAfterMs;

    //check if is offline and rec status is not equal to offline
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

// function that creates the Alert Manager
function createAlertManager() {
  return {
    updateReading,
    checkHeartbeats,
    setNotifier,
    getStates,
  };
}

module.exports = { createAlertManager, setConfigGetter };
