"use strict";

var nodemailer = require("nodemailer");
var EmailTemplate = require("../schemas/emailTemplate");
var renderTemplate = require("./renderTemplate");
var qrCode = require("./qrCode");

// {{qrcode}} in a template body marks where the recipient's check-in QR image
// goes; templates without it get no QR. It is first rendered as this marker
// (nothing in it gets HTML-escaped), then the marker is swapped for the image
// tag / a text-version note.
var QR_TOKEN = /\{\{\s*qrcode\s*\}\}/;
var QR_MARKER = "%%CHECKIN_QR_CODE%%";
var QR_CID = "checkin-qrcode";
var QR_IMG_HTML =
  '<img src="cid:' + QR_CID + '" alt="Your check-in QR code" width="240" height="240" ' +
  'style="display:block;max-width:100%;height:auto;" />';
var QR_TEXT = "(Your check-in QR code is attached to this email as an image.)";

// Bare http(s) URLs in a rendered (already HTML-escaped) body. Trailing
// sentence punctuation is left out of the link.
var URL_PATTERN = /https?:\/\/[^\s<]+[^\s<.,;:!?)'"]/g;

/**
 * Make bare URLs in an HTML-escaped email body clickable.
 * @param {string} html - Escaped HTML.
 * @returns {string}
 */
function linkify(html) {
  return html.replace(URL_PATTERN, function toLink(url) {
    return '<a href="' + url + '">' + url + "</a>";
  });
}

/**
 * Whether SMTP is configured for outgoing email. Needs a host and a sender
 * address; login credentials are optional (see buildTransport).
 * @returns {boolean}
 */
function isMailConfigured() {
  return Boolean(process.env.SMTP_HOST && (process.env.MAIL_FROM || process.env.SMTP_USER));
}

/**
 * Build a nodemailer transport from environment config. Created lazily so the
 * app can boot without SMTP configured (password reset simply won't send).
 *
 * Logs in only when SMTP_USER is set. Relays that authorize by the server's
 * IP address instead (e.g. Google Workspace's SMTP relay, since Workspace no
 * longer accepts password sign-in from apps) reject a login they didn't ask
 * for, so leave SMTP_USER/SMTP_PASS empty for those.
 *
 * @returns {object} A nodemailer transport.
 */
function buildTransport() {
  var options = {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE) === "true",
  };
  if (process.env.SMTP_USER) {
    options.auth = {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    };
  }
  // The name we greet the server with (EHLO). Without it, a host whose name
  // has no dot introduces itself as "[127.0.0.1]", which relays distrust.
  if (process.env.SMTP_EHLO_NAME) {
    options.name = process.env.SMTP_EHLO_NAME;
  }
  return nodemailer.createTransport(options);
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
 * Whether a template body asks for the check-in QR code.
 * @param {string} body - Template body.
 * @returns {boolean}
 */
function usesQrCode(body) {
  return QR_TOKEN.test(String(body || ""));
}

/**
 * Render a template (subject + body) into a ready-to-send email. Shared by real
 * sends, the admin preview and test sends, so all three match.
 *
 * {{qrcode}}: when the body contains it and a `qrId` is given, the code is drawn
 * as a QR image *at that spot*. Real emails embed it as an inline (cid:)
 * attachment, because Gmail and Outlook strip data: URLs; the admin preview uses
 * a data: URL instead. Without the variable, no QR is attached.
 *
 * @param {object} template - `{ subject, body }`.
 * @param {object} values - Placeholder values ({{name}}, {{status}}, …).
 * @param {object} [options]
 * @param {string} [options.qrId] - The recipient's check-in code.
 * @param {boolean} [options.dataUrlImages] - Inline the QR as a data: URL
 *   (for in-browser preview) instead of a cid: attachment.
 * @returns {Promise<{subject: string, text: string, html: string, attachments: Array<object>}>}
 */
function renderEmail(template, values, options) {
  var opts = options || {};
  var body = template.body || "";
  var qrId = usesQrCode(body) ? opts.qrId : null;
  var orgName = process.env.ORG_NAME || "the hackathon";

  // Org-wide links come from env so every template can use them.
  var renderValues = Object.assign({}, values, {
    orgName: orgName,
    websiteUrl: process.env.ORG_WEBSITE_URL || "",
    discordUrl: process.env.ORG_DISCORD_URL || "",
    qrcode: qrId ? QR_MARKER : "",
  });

  var subject = renderTemplate(template.subject, renderValues);
  var text = renderTemplate(body, renderValues);
  var html = linkify(renderTemplate(body, renderValues, { escapeHtml: true })).replace(/\n/g, "<br />");

  if (!qrId) {
    return Promise.resolve({ subject: subject, text: text, html: html, attachments: [] });
  }

  if (opts.dataUrlImages) {
    return qrCode.toDataUrl(qrId).then(function afterRender(dataUrl) {
      return {
        subject: subject,
        text: text.split(QR_MARKER).join(QR_TEXT),
        html: html.split(QR_MARKER).join(QR_IMG_HTML.replace("cid:" + QR_CID, dataUrl)),
        attachments: [],
      };
    });
  }

  return qrCode.toPngBuffer(qrId).then(function afterRender(png) {
    return {
      subject: subject,
      text: text.split(QR_MARKER).join(QR_TEXT),
      html: html.split(QR_MARKER).join(QR_IMG_HTML),
      attachments: [
        {
          filename: "checkin-qr.png",
          content: png,
          contentType: "image/png",
          cid: QR_CID,
        },
      ],
    };
  });
}

/**
 * Send an already-loaded template to one recipient. If the body contains
 * {{qrcode}}, the recipient's check-in code (SHA-256 of their email) is
 * resolved, saved on their account, and embedded.
 *
 * @param {string} to - Recipient email address.
 * @param {object} template - `{ subject, body }`.
 * @param {object} values - Placeholder values for the template.
 * @param {object} [options]
 * @param {string} [options.qrId] - Use this code instead of looking it up.
 * @param {object} [options.icalEvent] - Calendar invite, passed to
 *   nodemailer as-is: { filename, method, content }.
 * @returns {Promise<void>}
 */
function sendRenderedTemplate(to, template, values, options) {
  var opts = options || {};
  // Required here, not at the top, to keep schemas → utils one-directional.
  var User = require("../schemas/user");
  var qrIdPromise =
    usesQrCode(template.body) && !opts.qrId ? User.ensureQrIdForEmail(to) : Promise.resolve(opts.qrId || null);

  return qrIdPromise
    .then(function afterQrId(qrId) {
      return renderEmail(template, values, { qrId: qrId });
    })
    .then(function afterRender(rendered) {
      var mail = {
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to: to,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      };
      if (rendered.attachments.length) {
        mail.attachments = rendered.attachments;
      }
      if (opts.icalEvent) {
        // Sent as a text/calendar part, which Gmail and Outlook show as an
        // invite with "Add to calendar".
        mail.icalEvent = opts.icalEvent;
      }
      return buildTransport().sendMail(mail);
    })
    .then(function afterSend() {
      return undefined;
    });
}

/**
 * Send an email using a stored template (looked up by key).
 *
 * @param {string} to - Recipient email address.
 * @param {string} templateKey - Template key to load from the database.
 * @param {object} values - Placeholder values for the template.
 * @param {object} [options] - See sendRenderedTemplate.
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

  return EmailTemplate.findOne({ key: templateKey }).then(function afterFind(template) {
    if (!template) {
      // Guards in the admin controller stop the built-ins being renamed or
      // deleted, but a template can still be missing (a key typo'd at the
      // call site, a database restored without seeding). Say so rather than
      // dropping the email silently.
      console.warn("No email template found for key; skipped sending:", templateKey);
      return undefined;
    }
    return sendRenderedTemplate(to, template, values, options);
  });
}

module.exports = {
  isMailConfigured: isMailConfigured,
  sendPasswordReset: sendPasswordReset,
  sendTemplateEmail: sendTemplateEmail,
  sendRenderedTemplate: sendRenderedTemplate,
  renderEmail: renderEmail,
  usesQrCode: usesQrCode,
};
