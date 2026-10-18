"use strict";

var crypto = require("crypto");
var QRCode = require("qrcode");

// A check-in code is 64 lowercase hex characters (a SHA-256 digest).
var QR_ID_PATTERN = /^[a-f0-9]{64}$/;

// Rendering options shared by the emailed PNG and the dashboard image. "M"
// error correction survives a cracked phone screen or a dim room.
var RENDER_OPTIONS = {
  errorCorrectionLevel: "M",
  margin: 2,
  width: 320,
};

/**
 * The key the check-in code is signed with. QR_SECRET is preferred so codes
 * survive a JWT secret rotation; JWT_SECRET is the fallback so a deployment
 * that hasn't set it up yet still works.
 * @returns {string}
 */
function qrSecret() {
  return process.env.QR_SECRET || process.env.JWT_SECRET || "";
}

/**
 * Derive an attendee's check-in code from their email: HMAC-SHA256 keyed by
 * the server secret. Keyed rather than a bare SHA-256 so nobody can mint a
 * working code for someone else just by knowing their email address.
 *
 * @param {string} email - The email the applicant applied with.
 * @returns {string} 64-character lowercase hex code.
 */
function computeQrId(email) {
  var normalized = String(email || "").trim().toLowerCase();
  return crypto.createHmac("sha256", qrSecret()).update(normalized).digest("hex");
}

/**
 * Normalize a scanned or typed code: trim whitespace (handheld scanners often
 * append a newline) and lowercase it.
 * @param {*} value - Raw code from the request.
 * @returns {string} The normalized code, or "" when it is not a valid code.
 */
function normalizeQrId(value) {
  var code = String(value == null ? "" : value).trim().toLowerCase();
  return QR_ID_PATTERN.test(code) ? code : "";
}

/**
 * Render a check-in code as a PNG, for attaching to an email.
 * @param {string} qrId - The attendee's check-in code.
 * @returns {Promise<Buffer>}
 */
function toPngBuffer(qrId) {
  return QRCode.toBuffer(qrId, Object.assign({ type: "png" }, RENDER_OPTIONS));
}

/**
 * Render a check-in code as a PNG data URL, for showing in the dashboard.
 * @param {string} qrId - The attendee's check-in code.
 * @returns {Promise<string>}
 */
function toDataUrl(qrId) {
  return QRCode.toDataURL(qrId, Object.assign({ type: "image/png" }, RENDER_OPTIONS));
}

module.exports = {
  computeQrId: computeQrId,
  normalizeQrId: normalizeQrId,
  toPngBuffer: toPngBuffer,
  toDataUrl: toDataUrl,
};
