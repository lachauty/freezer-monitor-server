// discord.js (CommonJS)
// Minimal Discord webhook client with basic rate limiting and 429 retry.
// Requires Node 18+ (uses global fetch).

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const MIN_GAP_SEC = Number(process.env.DISCORD_MIN_SECONDS_BETWEEN_POSTS || 0);

let lastPostMs = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function postToDiscord(content, embeds = [], opts = {}) {
  if (!WEBHOOK) {
    return { ok: false, skipped: true, reason: "DISCORD_WEBHOOK_URL missing" };
  }

  // simple flood control
  const now = Date.now();
  if (MIN_GAP_SEC > 0 && now - lastPostMs < MIN_GAP_SEC * 1000) {
    await sleep(MIN_GAP_SEC * 1000 - (now - lastPostMs));
  }

  const payload = {
    content: content ?? "",
    embeds,
  };
  if (opts.username) payload.username = opts.username;
  if (opts.avatar_url) payload.avatar_url = opts.avatar_url;

  // thread support (optional)
  let url = WEBHOOK;
  if (opts.thread_id) url += (url.includes("?") ? "&" : "?") + "thread_id=" + encodeURIComponent(opts.thread_id);

  // up to 2 tries; handle 429 Retry-After
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });

    if (res.status === 204) {
      lastPostMs = Date.now();
      return { ok: true, status: 204 };
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") || "1");
      await sleep(Math.max(1, retryAfter) * 1000);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (attempt === 2) return { ok: false, status: res.status, body: text };
      await sleep(400);
    }
  }
  return { ok: false, status: 0, body: "Unknown error" };
}

function buildFreezerEmbed({ deviceId, tempC, bounds, status, whenIso, url }) {
  return [
    {
      title: deviceId || "ESP32",
      description: status || "Alert",
      url: url || undefined,
      fields: [
        { name: "Temp (°C)", value: (tempC ?? '—').toString(), inline: true },
        { name: "Bounds", value: bounds || "—", inline: true },
      ],
      timestamp: whenIso || new Date().toISOString(),
    },
  ];
}

module.exports = { postToDiscord, buildFreezerEmbed };
