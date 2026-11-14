"use strict";

var crypto = require("crypto");
var primaryClientOrigin = require("./clientOrigin").primaryClientOrigin;

/**
 * Unsubscribe links for announcement emails.
 *
 * The link has to work without logging in and from an old email, so it carries
 * a keyed hash of the user's id (HMAC with JWT_SECRET) instead of an expiring
 * token. Anyone holding it can do exactly one thing: turn that user's
 * announcement emails off. It can't be forged for other users.
 */

/**
 * @param {*} userId - The user's _id.
 * @returns {string} Hex HMAC of the id.
 */
function sign(userId) {
  var secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not set. Copy .env.example to .env.");
  }
  return crypto.createHmac("sha256", secret).update("unsubscribe:" + String(userId)).digest("hex");
}

/**
 * Check an unsubscribe token in constant time.
 * @param {*} userId - The user id from the link.
 * @param {*} token - The token from the link.
 * @returns {boolean}
 */
function verify(userId, token) {
  var expected = Buffer.from(sign(userId));
  var given = Buffer.from(String(token || ""));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * The frontend page that confirms the unsubscribe (it POSTs to
 * /api/auth/unsubscribe, so a mail scanner opening the link can't unsubscribe
 * anyone by accident).
 * @param {*} userId - The user's _id.
 * @returns {string} Full URL.
 */
function link(userId) {
  return (
    primaryClientOrigin() +
    "/unsubscribe?u=" +
    encodeURIComponent(String(userId)) +
    "&t=" +
    sign(userId)
  );
}

// ---- Category tokens --------------------------------------------------------
// Every optional email carries one: `<payload>.<signature>`, where the payload
// is base64url JSON `{ u: userId, c: category }`. Like the older u/t links it
// never expires (it must work from an old email) and only lets the holder
// change that one person's optional email preferences. The category says
// which kind of email the link came from, so the page can offer "turn these
// off" first. Older `?u=&t=` links keep working (they mean announcements).

/**
 * @param {string} payload - Encoded payload.
 * @returns {string} base64url HMAC of it.
 */
function signPayload(payload) {
  var secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not set. Copy .env.example to .env.");
  }
  return crypto.createHmac("sha256", secret).update("email-preferences:" + payload).digest("base64url");
}

/**
 * @param {*} userId - The user's _id.
 * @param {string} category - Email category (utils/emailCategories).
 * @returns {string} The token.
 */
function createToken(userId, category) {
  var payload = Buffer.from(JSON.stringify({ u: String(userId), c: String(category || "") })).toString("base64url");
  return payload + "." + signPayload(payload);
}

/**
 * Check a category token in constant time and read it.
 * @param {*} token - Token from a link.
 * @returns {{userId: string, category: string}|null} Null when invalid.
 */
function readToken(token) {
  var text = String(token || "");
  var dot = text.indexOf(".");
  if (dot < 1 || text.length > 1000) {
    return null;
  }
  var payload = text.slice(0, dot);
  var expected = Buffer.from(signPayload(payload));
  var given = Buffer.from(text.slice(dot + 1));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return null;
  }
  try {
    var data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data || typeof data.u !== "string" || typeof data.c !== "string") {
      return null;
    }
    return { userId: data.u, category: data.c };
  } catch (_err) {
    return null;
  }
}

/**
 * The preferences page for one email (no login needed).
 * @param {*} userId - The user's _id.
 * @param {string} category - Email category.
 * @returns {string} Full URL.
 */
function categoryLink(userId, category) {
  return primaryClientOrigin() + "/unsubscribe?token=" + createToken(userId, category);
}

/**
 * The RFC 8058 one-click address mail clients POST to ("Unsubscribe" button
 * in Gmail and others). It must be the API itself, so it needs
 * API_PUBLIC_URL; without it there is no one-click address.
 * @param {*} userId - The user's _id.
 * @param {string} category - Email category.
 * @returns {string} Full URL, or "" when API_PUBLIC_URL is unset.
 */
function oneClickLink(userId, category) {
  var base = String(process.env.API_PUBLIC_URL || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) {
    return "";
  }
  return base + "/api/auth/unsubscribe/one-click?token=" + encodeURIComponent(createToken(userId, category));
}

/**
 * The List-Unsubscribe headers for an email.
 * @param {*} userId - The user's _id.
 * @param {string} category - Email category.
 * @returns {object} Header name -> value.
 */
function headers(userId, category) {
  var oneClick = oneClickLink(userId, category);
  var page = categoryLink(userId, category);
  if (!oneClick) {
    return { "List-Unsubscribe": "<" + page + ">" };
  }
  return {
    "List-Unsubscribe": "<" + oneClick + ">, <" + page + ">",
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

module.exports = {
  sign: sign,
  verify: verify,
  link: link,
  createToken: createToken,
  readToken: readToken,
  categoryLink: categoryLink,
  oneClickLink: oneClickLink,
  headers: headers,
};
