"use strict";

/**
 * Posts to the Discord channels the Communications page writes to:
 *   DISCORD_ANNOUNCEMENTS_WEBHOOK_URL  general announcements
 *   DISCORD_WORKSHOPS_WEBHOOK_URL      workshop reminders and sign-up posts
 *
 * A post is an embed (title, description, optional link, the brand colour),
 * plain text (`content`), or both. Nobody is pinged unless the post asks:
 * `allowed_mentions` is always sent and lists exactly the roles (and
 * @everyone / @here) the writer used, so a user or role mention that merely
 * appears in a workshop title stays plain text. A 429 is retried after
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
var MAX_CONTENT = 2000;
var SNOWFLAKE = /^\d{17,20}$/;
var BUILT_IN_MENTIONS = ["everyone", "here"];
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
 * Replace `@everyone`, `@here` and `@<label>` in a message. A label that is a
 * saved tag becomes `<@&roleId>`; any other `@word` stays plain text.
 * @param {string} text - What the writer typed.
 * @param {Array<{label: string, roleId: string}>} tags - Saved Discord mention tags.
 * @returns {{text: string, roleIds: Array<string>, everyone: boolean, here: boolean, labels: Array<string>}}
 *   `labels` are the mentions that will ping, as typed ("@participants"), in order.
 */
function resolveMentions(text, tags) {
  var byLabel = {};
  (tags || []).forEach(function each(tag) {
    if (tag && SNOWFLAKE.test(String(tag.roleId))) {
      byLabel[String(tag.label).toLowerCase()] = String(tag.roleId);
    }
  });
  var out = { text: "", roleIds: [], everyone: false, here: false, labels: [] };
  out.text = String(text || "").replace(/(^|[^A-Za-z0-9_@])@([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/g, function swap(match, before, word) {
    var key = word.toLowerCase();
    var label = "@" + key;
    var replacement = null;
    if (key === "everyone" || key === "here") {
      out[key] = true;
      replacement = label;
    } else if (Object.prototype.hasOwnProperty.call(byLabel, key)) {
      var id = byLabel[key];
      if (out.roleIds.indexOf(id) === -1) {
        out.roleIds.push(id);
      }
      replacement = "<@&" + id + ">";
    }
    if (replacement === null) {
      return match;
    }
    if (out.labels.indexOf(label) === -1) {
      out.labels.push(label);
    }
    return before + replacement;
  });
  return out;
}

/**
 * @param {*} value - Candidate tag label.
 * @returns {boolean} Lowercase letters, numbers and dashes, 1 to 32 characters, not a built-in.
 */
function isValidLabel(value) {
  return (
    typeof value === "string" &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) &&
    value.length <= 32 &&
    BUILT_IN_MENTIONS.indexOf(value) === -1
  );
}

/**
 * @param {*} value - Candidate role id.
 * @returns {boolean} A Discord snowflake (17 to 20 digits).
 */
function isValidRoleId(value) {
  return typeof value === "string" && SNOWFLAKE.test(value);
}

/**
 * Build the webhook body for one post.
 * @param {object} post
 * @param {string} post.title - Embed title (cut to 256).
 * @param {string} post.description - Embed text (cut to 4096).
 * @param {string} [post.url] - Makes the title a link.
 * @param {string} [post.color] - #RRGGBB.
 * @param {boolean} [post.mentionEveryone] - Ping @everyone (older posts without `mentions`).
 * @param {string} [post.content] - Message text above the embed (the only thing that pings).
 * @param {object} [post.mentions] - `{ roleIds, everyone, here }` that may ping.
 * @returns {object} JSON body for the webhook.
 */
function buildPayload(post) {
  var mentions = post.mentions || {};
  var roleIds = (mentions.roleIds || []).filter(isValidRoleId);
  var everyone = post.mentionEveryone === true || mentions.everyone === true || mentions.here === true;
  var allowed = { parse: everyone ? ["everyone"] : [] };
  if (roleIds.length) {
    allowed.roles = roleIds.slice(0, 100);
  }
  var content = post.content !== undefined ? clip(post.content, MAX_CONTENT) : "";
  if (!post.title && !post.description) {
    var plain = { allowed_mentions: allowed };
    if (content) {
      plain.content = content;
    }
    return plain;
  }
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
  var body = { embeds: [embed], allowed_mentions: allowed };
  if (content) {
    body.content = content;
  } else if (post.mentionEveryone === true) {
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
  MAX_CONTENT: MAX_CONTENT,
  BUILT_IN_MENTIONS: BUILT_IN_MENTIONS,
  resolveMentions: resolveMentions,
  isValidLabel: isValidLabel,
  isValidRoleId: isValidRoleId,
  isConfigured: isConfigured,
  buildPayload: buildPayload,
  send: send,
  clip: clip,
};
