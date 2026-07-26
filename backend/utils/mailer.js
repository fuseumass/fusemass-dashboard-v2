"use strict";

var nodemailer = require("nodemailer");

/**
 * Whether SMTP is configured for outgoing email.
 * @returns {boolean}
 */
function isMailConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER);
}

/**
 * Build a nodemailer transport from environment config. Created lazily so the
 * app can boot without SMTP configured (password reset simply won't send).
 * @returns {object} A nodemailer transport.
 */
function buildTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE) === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

/**
 * Send the password-reset email containing a link back to the frontend.
 *
 * @param {string} to - Recipient email address.
 * @param {string} resetUrl - Full frontend URL including the reset token.
 * @returns {Promise<void>}
 */
function sendPasswordReset(to, resetUrl) {
  if (!isMailConfigured()) {
    // Don't crash the flow in dev — log the link so it can be used manually.
    console.warn("SMTP not configured; password reset link:", resetUrl);
    return Promise.resolve();
  }

  var orgName = process.env.ORG_NAME || "the hackathon";
  var from = process.env.MAIL_FROM || process.env.SMTP_USER;

  return buildTransport()
    .sendMail({
      from: from,
      to: to,
      subject: "Reset your " + orgName + " password",
      text:
        "You requested a password reset for " +
        orgName +
        ".\n\nReset it here (link expires in 1 hour):\n" +
        resetUrl +
        "\n\nIf you didn't request this, you can ignore this email.",
      html:
        "<p>You requested a password reset for <strong>" +
        orgName +
        "</strong>.</p>" +
        '<p><a href="' +
        resetUrl +
        '">Click here to reset your password</a> (link expires in 1 hour).</p>' +
        "<p>If you didn't request this, you can ignore this email.</p>",
    })
    .then(function afterSend() {
      return undefined;
    });
}

module.exports = {
  isMailConfigured: isMailConfigured,
  sendPasswordReset: sendPasswordReset,
};
