"use strict";

var crypto = require("crypto");
var User = require("../schemas/user");
var clientOrigin = require("../utils/clientOrigin");

// Link a dashboard account to a Discord account with Discord OAuth2 (scope
// "identify"). Based on PR #99 by Noah Shayne.
//
// 1. GET /api/discord/link returns the Discord authorize URL. Its `state` is
//    an HMAC of the signed-in user's id and an expiry, so a code can only be
//    redeemed by the account that started linking (a link someone else sends
//    you can't attach their Discord account to yours).
// 2. Discord sends the person back to the redirect page with ?code&state.
// 3. POST /api/discord/callback exchanges the code for an access token, reads
//    the Discord user id and stores it on the account. The Discord tokens are
//    used once and never stored.

var STATE_TTL_MS = 10 * 60 * 1000;
var DISCORD_API = "https://discord.com/api/v10";

/** @returns {boolean} Whether the Discord app credentials are set. */
function configured() {
  return Boolean(process.env.DISCORD_APP_CLIENT_ID && process.env.DISCORD_APP_CLIENT_SECRET);
}

/** @returns {string} The page Discord returns to (must match the Developer Portal). */
function redirectUri() {
  return process.env.DISCORD_REDIRECT_URI || clientOrigin.primaryClientOrigin() + "/dashboard/discord";
}

/**
 * @param {string} userId - Account starting the link.
 * @param {number} expires - Expiry time in ms.
 * @returns {string} Hex HMAC binding the two.
 */
function sign(userId, expires) {
  return crypto.createHmac("sha256", String(process.env.JWT_SECRET)).update("discord-link:" + userId + ":" + expires).digest("hex");
}

/**
 * @param {string} userId - Signed-in account.
 * @returns {string} OAuth state for this account.
 */
function makeState(userId) {
  var expires = Date.now() + STATE_TTL_MS;
  return expires + "." + sign(userId, expires);
}

/**
 * @param {*} state - From the query string.
 * @param {string} userId - Signed-in account.
 * @returns {boolean} Whether this account issued it and it hasn't expired.
 */
function validState(state, userId) {
  var parts = typeof state === "string" ? state.split(".") : [];
  if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !/^[a-f0-9]{64}$/.test(parts[1])) return false;
  if (Number(parts[0]) < Date.now()) return false;
  var expected = Buffer.from(sign(userId, parts[0]), "hex");
  return crypto.timingSafeEqual(expected, Buffer.from(parts[1], "hex"));
}

/**
 * GET /api/discord/link - Linking status and, when configured, the authorize URL.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @param {function} next - Error handler.
 * @returns {Promise<void>}
 */
async function status(req, res, next) {
  try {
    var user = await User.findById(req.user.id).select("discordId discordUsername").lean();
    if (!user) return res.status(404).json({ error: "User account not found." });
    var body = { configured: configured(), linked: Boolean(user.discordId), username: user.discordUsername || "" };
    if (body.configured) {
      body.url = "https://discord.com/oauth2/authorize?" + new URLSearchParams({
        client_id: process.env.DISCORD_APP_CLIENT_ID,
        response_type: "code",
        redirect_uri: redirectUri(),
        scope: "identify",
        state: makeState(req.user.id),
        prompt: "consent",
      }).toString();
    }
    res.json(body);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/discord/callback - Body { code, state }. Links the signed-in account.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @param {function} next - Error handler.
 * @returns {Promise<void>}
 */
async function callback(req, res, next) {
  var body = req.body || {};
  if (!configured()) return res.status(503).json({ error: "Discord linking isn't set up yet." });
  if (typeof body.code !== "string" || !body.code || body.code.length > 200) {
    return res.status(400).json({ error: "Discord authorization code is required." });
  }
  if (!validState(body.state, req.user.id)) {
    return res.status(400).json({ error: "This Discord link expired or wasn't started from your account. Try again." });
  }
  try {
    var tokenResponse = await fetch(DISCORD_API + "/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_APP_CLIENT_ID,
        client_secret: process.env.DISCORD_APP_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: body.code,
        redirect_uri: redirectUri(),
      }),
    });
    if (!tokenResponse.ok) {
      console.error("Discord token exchange failed with status", tokenResponse.status);
      return res.status(502).json({ error: "Discord didn't accept the link. Try again." });
    }
    var accessToken = (await tokenResponse.json()).access_token;
    if (!accessToken) return res.status(502).json({ error: "Discord didn't return an access token. Try again." });

    var userResponse = await fetch(DISCORD_API + "/users/@me", { headers: { Authorization: "Bearer " + accessToken } });
    if (!userResponse.ok) return res.status(502).json({ error: "Couldn't read your Discord account. Try again." });
    var discordUser = await userResponse.json();
    if (!discordUser || !/^\d{5,25}$/.test(String(discordUser.id))) {
      return res.status(502).json({ error: "Discord didn't return a user id. Try again." });
    }
    var discordId = String(discordUser.id);
    var username = String(discordUser.username || "").slice(0, 100);

    if (await User.exists({ discordId: discordId, _id: { $ne: req.user.id } })) {
      return res.status(409).json({ error: "That Discord account is already linked to another dashboard account." });
    }
    var updated = await User.findByIdAndUpdate(req.user.id, { $set: { discordId: discordId, discordUsername: username } }, { new: true });
    if (!updated) return res.status(404).json({ error: "User account not found." });
    res.json({ linked: true, username: username });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ error: "That Discord account is already linked to another dashboard account." });
    }
    next(err);
  }
}

/**
 * DELETE /api/discord/link - Unlink the signed-in account.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @param {function} next - Error handler.
 * @returns {Promise<void>}
 */
async function unlink(req, res, next) {
  try {
    await User.updateOne({ _id: req.user.id }, { $unset: { discordId: 1, discordUsername: 1 } });
    res.json({ linked: false });
  } catch (err) {
    next(err);
  }
}

module.exports = { status: status, callback: callback, unlink: unlink, validState: validState, makeState: makeState };
