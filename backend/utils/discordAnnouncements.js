"use strict";

/**
 * Posts to the Discord channels the Communications page writes to:
 *   DISCORD_ANNOUNCEMENTS_WEBHOOK_URL  general announcements
 *   DISCORD_WORKSHOPS_WEBHOOK_URL      workshop reminders and sign-up posts
 *
 * Each post is one embed (title, description, optional link, the brand
 * colour). Nobody is pinged unless the post asks for @everyone explicitly:
 * `allowed_mentions` is always sent, so a name typed as "@everyone" or a role
 * mention in a workshop title stays plain text. A 429 is retried after
 * Discord's `retry_after`. Webhook URLs are secrets; they are never logged or
 * returned by the API.
 */

var CHANNEL_ENV = {
  discord_announcements: "DISCORD_ANNOUNCEMENTS_WEBHOOK_URL",
  discord_workshops: "DISCORD_WORKSHOPS_WEBHOOK_URL",
};

// Discord's limits for an embed.
var MAX_TITLE = 256;
var MAX_DESCRIPTION = 4096;
var MAX_ATTEMPTS = 3;
var MAX_RETRY_WAIT_MS = 30 * 1000;
var POST_TIMEOUT_MS = 10 * 1000;

/**
 * @param {string} channel - "discord_announcements" | "discord_workshops".
 * @returns {string} The webhook URL, or "" when not configured.
 */
function webhookUrl(channel) {
  var name = CHANNEL_ENV[channel];
  var value = name ? String(process.env[name] || "").trim() : "";
  return /^https?:\/\//i.test(value) ? value : "";
}

/**
 * @param {string} channel - A Discord channel key.
 * @returns {boolean} Whether it has a webhook.
 */
function isConfigured(channel) {
  return Boolean(webhookUrl(channel));
}

/**
 * @param {string} text - Anything.
 * @param {number} max - Longest allowed length.
 * @returns {string} The text, cut with an ellipsis when too long.
 */
function clip(text, max) {
  var value = String(text || "");
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

/**
 * "#4f46e5" -> 0x4f46e5, for the embed colour.
 * @param {string} hex - #RRGGBB.
 * @returns {number|undefined}
 */
function colorNumber(hex) {
  return /^#[0-9a-f]{6}$/i.test(String(hex || "")) ? parseInt(String(hex).slice(1), 16) : undefined;
}

/**
 * @param {string} value - Candidate link.
 * @returns {string} The link when it is a real http(s) URL, else "".
 */
function cleanUrl(value) {
  try {
    var parsed = new URL(String(value || "").trim());
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : "";
  } catch (_err) {
    return "";
  }
}

/**
 * Build the webhook body for one post.
 * @param {object} post
 * @param {string} post.title - Embed title (cut to 256).
 * @param {string} post.description - Embed text (cut to 4096).
 * @param {string} [post.url] - Makes the title a link.
 * @param {string} [post.color] - #RRGGBB.
 * @param {boolean} [post.mentionEveryone] - Ping @everyone.
 * @returns {object} JSON body for the webhook.
 */
function buildPayload(post) {
  var embed = {
    title: clip(post.title, MAX_TITLE),
    description: clip(post.description, MAX_DESCRIPTION),
  };
  var url = cleanUrl(post.url);
  if (url) {
    embed.url = url;
  }
  var color = colorNumber(post.color);
  if (color !== undefined) {
    embed.color = color;
  }
  var body = {
    embeds: [embed],
    allowed_mentions: { parse: post.mentionEveryone === true ? ["everyone"] : [] },
  };
  if (post.mentionEveryone === true) {
    body.content = "@everyone";
  }
  return body;
}

/**
 * @param {number} ms - Milliseconds.
 * @returns {Promise<void>}
 */
function wait(ms) {
  return new Promise(function later(resolve) {
    setTimeout(resolve, ms);
  });
}

/**
 * How long Discord asked us to wait after a 429, in ms.
 * @param {object} res - fetch Response.
 * @returns {Promise<number>}
 */
function retryAfterMs(res) {
  return Promise.resolve()
    .then(function readBody() {
      return res.json();
    })
    .catch(function noBody() {
      return {};
    })
    .then(function pick(body) {
      var seconds = Number(body && body.retry_after);
      if (!(seconds >= 0)) {
        seconds = Number(res.headers && res.headers.get && res.headers.get("retry-after"));
      }
      if (!(seconds >= 0)) {
        seconds = 1;
      }
      return Math.min(Math.ceil(seconds * 1000), MAX_RETRY_WAIT_MS);
    });
}

/**
 * Post to a channel. Never throws: resolves with what happened.
 * @param {string} channel - "discord_announcements" | "discord_workshops".
 * @param {object} post - See buildPayload.
 * @returns {Promise<{status: string, messageId: string, error: string, attempts: number}>}
 *   status "sent", "failed" or "skipped" (no webhook configured).
 */
function send(channel, post) {
  var url = webhookUrl(channel);
  if (!url) {
    return Promise.resolve({ status: "skipped", messageId: "", error: "This Discord channel isn't set up.", attempts: 0 });
  }
  // wait=true makes Discord answer with the message, so we can store its id.
  var target = url + (url.indexOf("?") === -1 ? "?" : "&") + "wait=true";
  var body = JSON.stringify(buildPayload(post));
  var attempts = 0;

  function attempt() {
    attempts += 1;
    return fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body,
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    }).then(function afterPost(res) {
      if (res.status === 429 && attempts < MAX_ATTEMPTS) {
        return retryAfterMs(res).then(function backOff(ms) {
          return wait(ms).then(attempt);
        });
      }
      if (!res.ok) {
        return { status: "failed", messageId: "", error: "Discord answered " + res.status + ".", attempts: attempts };
      }
      return Promise.resolve()
        .then(function readBody() {
          return res.json();
        })
        .catch(function noBody() {
          return {};
        })
        .then(function done(message) {
          return { status: "sent", messageId: String((message && message.id) || ""), error: "", attempts: attempts };
        });
    });
  }

  return attempt().catch(function onError(err) {
    // The message never names the URL (it is a secret).
    var reason = err && err.name === "TimeoutError" ? "Discord didn't answer in time." : "Could not reach Discord.";
    return { status: "failed", messageId: "", error: reason, attempts: attempts };
  });
}

module.exports = {
  CHANNELS: Object.keys(CHANNEL_ENV),
  CHANNEL_ENV: CHANNEL_ENV,
  MAX_TITLE: MAX_TITLE,
  MAX_DESCRIPTION: MAX_DESCRIPTION,
  isConfigured: isConfigured,
  buildPayload: buildPayload,
  send: send,
  clip: clip,
};
