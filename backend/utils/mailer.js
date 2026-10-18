"use strict";

var nodemailer = require("nodemailer");
var EmailTemplate = require("../schemas/emailTemplate");
var renderTemplate = require("./renderTemplate");
var qrCode = require("./qrCode");

// {{qrcode}} in a template body marks where the check-in QR image goes. It is
// first rendered as this marker (nothing in it gets HTML-escaped), then the
// marker is swapped for the image tag / a text-version note.
var QR_TOKEN = /\{\{\s*qrcode\s*\}\}/;
var QR_MARKER = "%%CHECKIN_QR_CODE%%";
var QR_CID = "checkin-qrcode";
var QR_IMG_HTML =
  '<img src="cid:' + QR_CID + '" alt="Your check-in QR code" width="240" height="240" ' +
  'style="display:block;max-width:100%;height:auto;" />';
var QR_TEXT = "(Your check-in QR code is attached to this email as an image.)";

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

/**
 * Send an email using a stored template.
 *
 * @param {string} to - Recipient email address.
 * @param {string} templateKey - Template key to load from the database.
 * @param {object} values - Placeholder values for the template.
 * @param {object} [options] - Extra send options.
 * @param {string} [options.qrId] - Embed this check-in code as a QR image,
 *   where the template says {{qrcode}} or else at the end of the email.
 * @returns {Promise<void>}
 */
function sendTemplateEmail(to, templateKey, values, options) {
  if (!to) {
    return Promise.resolve();
  }

  if (!isMailConfigured()) {
    console.warn("SMTP not configured; skipped template email for:", templateKey);
    return Promise.resolve();
  }

  return EmailTemplate.findOne({ key: templateKey })
    .then(function afterFind(template) {
      if (!template) {
        // Guards in the admin controller stop the built-ins being renamed or
        // deleted, but a template can still be missing (a key typo'd at the
        // call site, a database restored without seeding). Say so rather than
        // dropping the email silently.
        console.warn("No email template found for key; skipped sending:", templateKey);
        return undefined;
      }

      var qrId = options && options.qrId;
      var orgName = process.env.ORG_NAME || "the hackathon";
      var from = process.env.MAIL_FROM || process.env.SMTP_USER;
      var renderValues = Object.assign({}, values, { orgName: orgName, qrcode: qrId ? QR_MARKER : "" });
      var body = template.body || "";
      // Templates seeded before {{qrcode}} existed (or edited to drop it)
      // still have to deliver the code, so it goes at the end.
      if (qrId && !QR_TOKEN.test(body)) {
        body += "\n\n{{qrcode}}";
      }
      var renderedSubject = renderTemplate(template.subject, renderValues);
      var renderedText = renderTemplate(body, renderValues);
      var renderedHtml = renderTemplate(body, renderValues, { escapeHtml: true }).replace(/\n/g, "<br />");

      if (!qrId) {
        return buildTransport().sendMail({
          from: from,
          to: to,
          subject: renderedSubject,
          text: renderedText,
          html: renderedHtml,
        });
      }

      return qrCode.toPngBuffer(qrId).then(function afterRender(png) {
        return buildTransport().sendMail({
          from: from,
          to: to,
          subject: renderedSubject,
          text: renderedText.split(QR_MARKER).join(QR_TEXT),
          html: renderedHtml.split(QR_MARKER).join(QR_IMG_HTML),
          // Inline (cid:) attachment rather than a data: URL, which Gmail and
          // Outlook strip from emails.
          attachments: [
            {
              filename: "checkin-qr.png",
              content: png,
              contentType: "image/png",
              cid: QR_CID,
            },
          ],
        });
      });
    })
    .then(function afterSend() {
      return undefined;
    });
}

module.exports = {
  isMailConfigured: isMailConfigured,
  sendPasswordReset: sendPasswordReset,
  sendTemplateEmail: sendTemplateEmail,
};
