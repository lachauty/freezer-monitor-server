// discord.js (CommonJS)
// Minimal Discord webhook client with basic rate limiting and 429 retry.

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const ENV_MIN_GAP_SEC = Number(process.env.DISCORD_MIN_SECONDS_BETWEEN_POSTS || 0);

// sleep function with a promise to set timeout for ms amount
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let lastPostMs = 0;

// async function to post to discord with content, ebeds, and options
async function postToDiscord(content, embeds = [], opts = {}) {
  // sets targetWebhook = options webhook url or set .env webhook
  const targetWebhook = opts.webhook_url || WEBHOOK;
  // checks if targetWebhook exists
  // send error message and populate field
  if (!targetWebhook) {
    return { ok: false, skipped: true, reason: "DISCORD_WEBHOOK_URL missing" };
  }

  // record current time
  const now = Date.now();
  // set minGapSec to numberized options field for min_gap_sec to validate via nullish coalescing operator
  const minGapSec = Number(opts.min_gap_sec ?? ENV_MIN_GAP_SEC);
  // if minGapSec is greater than 0 and delta time from last posted is less than minGapSec
  // sleep for mingapsec - deltaTime
  if (minGapSec > 0 && now - lastPostMs < minGapSec * 1000) {
    await sleep(minGapSec * 1000 - (now - lastPostMs));
  }

  // payload with instantiated parameters and checks if content exits, then set it to be empty
  const payload = { content: content ?? "", embeds };
  // if statement to check if options fields are filled and sets the payload fields
  if (opts.username) payload.username = opts.username;
  if (opts.avatar_url) payload.avatar_url = opts.avatar_url;

  // sets the url to the targetwebhood (discord)
  let url = targetWebhook;
  if (opts.thread_id) {
    url += (url.includes("?") ? "&" : "?") + "thread_id=" + encodeURIComponent(opts.thread_id);
  }

  // for loop to iterate through attempt 1 all the way to 2
  for (let attempt = 1; attempt <= 2; attempt++) {
    // set response to await to fetch for url, and populate fields
    // for method, headers, and body.
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });

    // checks for if response status is equal to 204 both in value and datatype
    if (res.status === 204) {
      // sets last posted ms to the current time
      lastPostMs = Date.now();
      // return populated fields
      return { ok: true, status: 204 };
    }
    // checks for if response is equal to 429 both in value and datatype
    if (res.status === 429) {
      // set retry to the values of response header for "retry-after" or 1
      const retryAfter = Number(res.headers.get("retry-after") || "1");
      // set to sleep based on whether 1 or retry second is greater
      await sleep(Math.max(1, retryAfter) * 1000);
      continue;
    }
    // checks if res ok field exists
    if (!res.ok) {
      // sets text to await for response to get a text catch
      const text = await res.text().catch(() => "");
      // if number of attempts reaches to the value and data type of 2
      // return the fields and await to sleep for 400 ms
      if (attempt === 2) return { ok: false, status: res.status, body: text };
      await sleep(400);
    }
  }
  // if nothing checks out, return error fields
  return { ok: false, status: 0, body: "Unknown error" };
}

// function to build devices details
function buildFreezerEmbed({ deviceId, tempC, bounds, status, whenIso, url }) {
  // returns populated fields and timestamp
  return [
    {
      title: deviceId || "ESP32",
      description: status || "Alert",
      url: url || undefined,
      fields: [
        { name: "Temp (°C)", value: (tempC ?? "—").toString(), inline: true },
        { name: "Bounds", value: bounds || "—", inline: true },
      ],
      timestamp: whenIso || new Date().toISOString(),
    },
  ];
}

module.exports = { postToDiscord, buildFreezerEmbed };
