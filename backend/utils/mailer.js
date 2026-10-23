"use strict";

var nodemailer = require("nodemailer");
var EmailTemplate = require("../schemas/emailTemplate");
var renderTemplate = require("./renderTemplate");
var qrCode = require("./qrCode");
var outbox = require("./outbox");
var unsubscribe = require("./unsubscribe");

// Every send is logged in the outbox (utils/outbox, schemas/emailLog): its
// status, attempts and last error, so failures are visible and retryable.
// This module still owns *how* an email is rendered and handed to SMTP.
var NOT_CONFIGURED = "Email isn't configured on the server (SMTP_HOST / SMTP_USER), so nothing was sent.";

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
    // A hung SMTP connection must not hold a request (or an outbox lease)
    // for nodemailer's default of up to ten minutes.
    connectionTimeout: 30 * 1000,
    greetingTimeout: 30 * 1000,
    socketTimeout: 60 * 1000,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

/**
 * Send the password-reset email containing a link back to the frontend.
 *
 * Logged in the outbox as "password_reset" but with nothing stored: the link
 * is a single-use credential, so it is never saved or retried. A failed one
 * is listed so staff can see it; the person just asks for another.
 *
 * @param {string} to - Recipient email address.
 * @param {string} resetUrl - Full frontend URL including the reset token.
 * @returns {Promise<void>}
 */
function sendPasswordReset(to, resetUrl) {
  var entry = { to: to, templateKey: "password_reset", sensitive: true, retry: false };

  if (!isMailConfigured()) {
    // Don't crash the flow in dev — log the link so it can be used manually.
    console.warn("SMTP not configured; password reset link:", resetUrl);
    return outbox.recordUnsent(entry, NOT_CONFIGURED);
  }

  var orgName = process.env.ORG_NAME || "the hackathon";
  var from = process.env.MAIL_FROM || process.env.SMTP_USER;
  var subject = "Reset your " + orgName + " password";

  return outbox
    .send(entry, function deliver() {
      return buildTransport()
        .sendMail({
          from: from,
          to: to,
          subject: subject,
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
        .then(function afterSend(info) {
          return { messageId: info && info.messageId, subject: subject };
        });
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
 * Render a template and hand it to SMTP, without logging anything (the
 * outbox wraps this). If the body contains {{qrcode}}, the recipient's
 * check-in code (SHA-256 of their email) is resolved, saved on their account,
 * and embedded.
 *
 * @param {string} to - Recipient email address.
 * @param {object} template - `{ subject, body }`.
 * @param {object} values - Placeholder values for the template.
 * @param {object} [options]
 * @param {string} [options.qrId] - Use this code instead of looking it up.
 * @param {object} [options.icalEvent] - Calendar invite, passed to
 *   nodemailer as-is: { filename, method, content }.
 * @param {string} [options.unsubscribeUrl] - Announcements: adds an unsubscribe
 *   footer and the List-Unsubscribe header, and fills {{unsubscribeUrl}}.
 * @returns {Promise<{messageId: string, subject: string}>}
 */
function deliverRendered(to, template, values, options) {
  var opts = options || {};
  // Required here, not at the top, to keep schemas → utils one-directional.
  var User = require("../schemas/user");
  var qrIdPromise =
    usesQrCode(template.body) && !opts.qrId ? User.ensureQrIdForEmail(to) : Promise.resolve(opts.qrId || null);
  var renderValues = opts.unsubscribeUrl ? Object.assign({}, values, { unsubscribeUrl: opts.unsubscribeUrl }) : values;
  var renderedSubject = "";

  return qrIdPromise
    .then(function afterQrId(qrId) {
      return renderEmail(template, renderValues, { qrId: qrId });
    })
    .then(function afterRender(rendered) {
      renderedSubject = rendered.subject;
      var text = rendered.text;
      var html = rendered.html;
      if (opts.unsubscribeUrl && text.indexOf(opts.unsubscribeUrl) === -1) {
        // The template didn't place {{unsubscribeUrl}} itself, so add the footer.
        var orgName = process.env.ORG_NAME || "the hackathon";
        var note = "You're receiving this because you opted in to announcements from {{orgName}}.";
        text += "\n\n--\n" + renderTemplate(note, { orgName: orgName }) + "\nUnsubscribe: " + opts.unsubscribeUrl;
        html +=
          '<p style="color:#666;font-size:12px;margin-top:24px;">' +
          renderTemplate(note, { orgName: orgName }, { escapeHtml: true }) +
          ' <a href="' +
          opts.unsubscribeUrl +
          '">Unsubscribe</a></p>';
      }

      var mail = {
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to: to,
        subject: rendered.subject,
        text: text,
        html: html,
      };
      if (opts.unsubscribeUrl) {
        mail.headers = { "List-Unsubscribe": "<" + opts.unsubscribeUrl + ">" };
      }
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
    .then(function afterSend(info) {
      return { messageId: info && info.messageId, subject: renderedSubject };
    });
}

/**
 * Look a stored template up by key and deliver it (no logging).
 * @param {string} to - Recipient email address.
 * @param {string} templateKey - Template key.
 * @param {object} values - Placeholder values.
 * @param {object} [options] - See deliverRendered.
 * @param {Promise<object>} [lookup] - A template lookup already under way (so
 *   it can overlap with writing the log row); done here when omitted.
 * @returns {Promise<{messageId: string, subject: string}>} Rejects with
 *   `code: "TEMPLATE_MISSING"` when there is no such template.
 */
function deliverByKey(to, templateKey, values, options, lookup) {
  return (lookup || EmailTemplate.findOne({ key: templateKey })).then(function afterFind(template) {
    if (!template) {
      // Guards in the admin controller stop the built-ins being renamed or
      // deleted, but a template can still be missing (a key typo'd at the
      // call site, a database restored without seeding). Say so rather than
      // dropping the email silently.
      console.warn("No email template found for key; skipped sending:", templateKey);
      var err = new Error("No email template found for key: " + templateKey);
      err.code = "TEMPLATE_MISSING";
      err.noRetry = true; // retrying can't help until someone creates it
      throw err;
    }
    return deliverRendered(to, template, values, options);
  });
}

/**
 * What a log row says about how its email is delivered: the calendar invite
 * it was queued with, and the unsubscribe link announcements carry.
 * @param {object} row - EmailLog document.
 * @returns {object} Options for deliverRendered.
 */
function optionsForRow(row) {
  var options = {};
  if (row.options && row.options.icalEvent) {
    options.icalEvent = row.options.icalEvent;
  }
  if ((row.category === "announcement" || row.category === "test") && row.user) {
    options.unsubscribeUrl = unsubscribe.link(row.user);
  }
  return options;
}

/**
 * Deliver a stored outbox row again (a retry or a resend): the template is
 * looked up and rendered afresh, so a fixed template is picked up. Used by
 * the outbox; call sendTemplateEmail for new emails.
 *
 * @param {object} row - EmailLog document.
 * @returns {Promise<{messageId: string, subject: string}>}
 */
function deliverStored(row) {
  var values = row.values && typeof row.values.toObject === "function" ? row.values.toObject() : row.values;
  return deliverByKey(row.to, row.templateKey, Object.assign({}, values), optionsForRow(row));
}

/**
 * Send an already-loaded template to one recipient, and log it in the
 * outbox. For an unsaved draft (the admin's template test); it is never
 * retried, since the draft isn't stored anywhere.
 *
 * @param {string} to - Recipient email address.
 * @param {object} template - `{ subject, body }`.
 * @param {object} values - Placeholder values for the template.
 * @param {object} [options] - See deliverRendered, plus:
 * @param {string} [options.templateKey] - Label for the outbox (default "test_email").
 * @returns {Promise<void>}
 */
function sendRenderedTemplate(to, template, values, options) {
  var opts = options || {};
  var entry = { to: to, templateKey: opts.templateKey || "test_email", category: "test", retry: false };

  return outbox
    .send(entry, function deliver() {
      return deliverRendered(to, template, values, opts);
    })
    .then(function afterSend() {
      return undefined;
    });
}

/**
 * Send an email using a stored template (looked up by key), logged in the
 * outbox. The promise settles with the first attempt: it rejects when SMTP
 * refuses it, as always. Unless `retry` is false the outbox then retries it
 * in the background with backoff, so callers that fire and forget lose
 * nothing, and callers that await and report the failure pass `retry: false`
 * (otherwise the person who saw "failed" could get it twice).
 *
 * @param {string} to - Recipient email address.
 * @param {string} templateKey - Template key to load from the database.
 * @param {object} values - Placeholder values for the template.
 * @param {object} [options] - See deliverRendered, plus:
 * @param {boolean} [options.retry] - false: one attempt, no background retry.
 * @param {string} [options.category] - "transactional" (default) or "announcement"
 *   (only sent to people who opted in; carries an unsubscribe link).
 * @param {*} [options.userId] - The recipient's user id, when known.
 * @param {*} [options.requestedBy] - Admin who triggered the send.
 * @param {*} [options.resendOf] - Outbox row this sends again.
 * @returns {Promise<void>}
 */
function sendTemplateEmail(to, templateKey, values, options) {
  if (!to) {
    return Promise.resolve();
  }

  var opts = options || {};
  var entry = {
    to: to,
    templateKey: templateKey,
    values: values,
    options: { icalEvent: opts.icalEvent },
    category: opts.category,
    user: opts.userId,
    retry: opts.retry,
    sensitive: opts.sensitive,
    requestedBy: opts.requestedBy,
    resendOf: opts.resendOf,
  };

  if (!isMailConfigured()) {
    console.warn("SMTP not configured; skipped template email for:", templateKey);
    return outbox.recordUnsent(entry, NOT_CONFIGURED);
  }

  // Looked up while the log row is being written, not after, so logging adds
  // as little delay as possible to the first attempt.
  var lookup = EmailTemplate.findOne({ key: templateKey }).exec();
  lookup.catch(function ignore() {}); // surfaced by deliverByKey, not here

  return outbox
    .send(entry, function deliver(row) {
      var deliverOptions = row ? optionsForRow(row) : {};
      if (opts.icalEvent) {
        deliverOptions.icalEvent = opts.icalEvent;
      }
      if (opts.qrId) {
        deliverOptions.qrId = opts.qrId;
      }
      return deliverByKey(to, templateKey, values, deliverOptions, lookup);
    })
    .then(
      function afterSend() {
        return undefined;
      },
      function onError(err) {
        if (err && err.code === "TEMPLATE_MISSING") {
          return undefined; // already warned, and recorded as failed in the outbox
        }
        throw err;
      }
    );
}

module.exports = {
  isMailConfigured: isMailConfigured,
  sendPasswordReset: sendPasswordReset,
  sendTemplateEmail: sendTemplateEmail,
  sendRenderedTemplate: sendRenderedTemplate,
  deliverStored: deliverStored,
  renderEmail: renderEmail,
  usesQrCode: usesQrCode,
};
