"use strict";

var mongoose = require("mongoose");

var Schema = mongoose.Schema;

var DEFAULT_TEMPLATES = [
  {
    key: "hardware_checkout",
    subject: "Hardware checkout: {{itemName}}",
    body: "Hi {{name}},\n\nYou checked out {{itemName}} at {{eventTime}}.\nReturn deadline: {{dueTime}}",
  },
  {
    key: "hardware_return",
    subject: "Hardware returned: {{itemName}}",
    body: "Hi {{name}},\n\nYour return of {{itemName}} was recorded at {{eventTime}}.",
  },
  {
    key: "hardware_reminder",
    subject: "Please return {{itemName}}",
    body: "Hi {{name}},\n\nPlease bring {{itemName}} back to the hardware desk.\nReturn deadline: {{dueTime}}",
  },
  {
    key: "application_received",
    subject: "Thanks for applying to {{orgName}}",
    body:
      "Hi {{name}},\n\nThanks for applying to {{orgName}}.\nYour application is currently pending review.\n\nStatus: {{status}}",
  },
  {
    key: "application_accepted",
    subject: "Your application to {{orgName}} was accepted",
    body:
      "Hi {{name}},\n\nCongratulations! Your application to {{orgName}} has been accepted.\n\nStatus: {{status}}\n\nThis QR code is your pass for event check-in and meals. Keep this email handy (it is also on your dashboard):\n\n{{qrcode}}",
  },
  {
    key: "application_rejected",
    subject: "Your application to {{orgName}} was not selected",
    body:
      "Hi {{name}},\n\nThank you for applying to {{orgName}}. After review, your application was not selected.\n\nStatus: {{status}}",
  },
  {
    // Sent on sign-up (and on "resend") to confirm the address belongs to the
    // person who registered. {{verifyUrl}} is the single-use link; it expires
    // after 24 hours.
    key: "verify_email",
    subject: "Verify your email for {{orgName}}",
    body:
      "Hi {{name}},\n\nThanks for signing up for {{orgName}}. Please confirm your email address to finish setting up your account (you need to do this before you can apply):\n{{verifyUrl}}\n\nThis link works for 24 hours. If it has expired, log in to the dashboard and ask for a new one.\n\nIf you didn't create this account, you can ignore this email.",
  },
  {
    // Sent when an application is waitlisted: by a reviewer, or automatically
    // on submit once a round reaches its accepted limit (instead of the
    // "received" email, which says the application is pending).
    key: "application_waitlisted",
    subject: "You're on the {{orgName}} waitlist",
    body:
      "Hi {{name}},\n\nThank you for applying to {{orgName}}. We can't offer you a spot right now, so your application is on our waitlist. If space opens up we'll email you right away. There's nothing more you need to do.\n\nStatus: {{status}}",
  },
  {
    // Sent with the acceptance email when the applicant applied without an
    // account (public applications, imports) and so has no password yet.
    // {{setupUrl}} sets one; it expires after 7 days.
    key: "account_setup",
    subject: "Set up your {{orgName}} account",
    body:
      "Hi {{name}},\n\nYou've been accepted to {{orgName}}, and we've created an account for you so you can see your status and check-in QR code on the dashboard.\n\nSet your password here (this link works for 7 days):\n{{setupUrl}}\n\nIf it has expired, use \"Forgot password\" on the login page with this email address.",
  },
  {
    // Sent when someone invites this email to their team. The invitee may
    // not have a password yet (applied without an account).
    key: "team_invite",
    subject: "{{inviterName}} invited you to join {{teamName}}",
    body:
      "Hi,\n\n{{inviterName}} invited you to join their team \"{{teamName}}\" for {{orgName}}.\n\nLog in to the dashboard to accept or decline: {{teamsUrl}}\n\nIf you applied without an account and haven't set a password yet, use \"Forgot password\" on the login page with this email address.",
  },
  {
    // Sent when staff check an attendee in on arrival. The run of show is
    // also attached as a calendar invite.
    key: "checked_in",
    subject: "You're checked in to {{orgName}}!",
    body:
      "Hi {{name}},\n\nYou're checked in to {{orgName}}. Welcome!\n\nIf you haven't joined our Discord yet, join now. It's where announcements, mentors and team-finding happen: {{discordUrl}}\n\n{{runOfShow}}\n\nSchedule updates, FAQs, maps and prizes are on our website: {{websiteUrl}}\n\nHappy hacking!",
  },
];

// Earlier default bodies of built-in templates. A stored template whose body
// is still exactly one of these was never edited by an admin, so seeding
// upgrades it to the current default (this is how existing databases get
// {{qrcode}} in the acceptance email). Edited templates are never touched.
var LEGACY_DEFAULT_BODIES = {
  application_accepted: [
    "Hi {{name}},\n\nCongratulations! Your application to {{orgName}} has been accepted.\n\nStatus: {{status}}",
  ],
};

// Derived from DEFAULT_TEMPLATES rather than written out again, so the two can
// never drift. These keys are referenced by name from the application,
// decision and check-in flows, so renaming or deleting one silently stops
// those emails.
var BUILT_IN_KEYS = DEFAULT_TEMPLATES.map(function pickKey(template) {
  return template.key;
});

/**
 * Email templates that can be edited by admins and later rendered into emails.
 *
 * @typedef {object} EmailTemplate
 * @property {string} key - Stable identifier for the template.
 * @property {string} subject - Email subject line.
 * @property {string} body - Email body content.
 */
var emailTemplateSchema = new Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true,
    },
    subject: {
      type: String,
      trim: true,
      default: "",
    },
    body: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

/**
 * Seed the built-in templates if they have not been added already, and
 * upgrade built-ins that still hold an old, unedited default body.
 *
 * @returns {Promise<Array<object>>} The newly created templates.
 */
emailTemplateSchema.statics.seedDefaults = function seedDefaults() {
  var EmailTemplate = this;

  return EmailTemplate.find({})
    .select("key body")
    .lean()
    .then(function afterFind(existingTemplates) {
      var existingKeys = existingTemplates.map(function mapKey(template) {
        return template.key;
      });
      var missingTemplates = DEFAULT_TEMPLATES.filter(function filterTemplate(template) {
        return existingKeys.indexOf(template.key) === -1;
      });

      var upgrades = existingTemplates.filter(function isUneditedLegacy(template) {
        var legacy = LEGACY_DEFAULT_BODIES[template.key] || [];
        return legacy.indexOf(template.body) !== -1;
      });

      return Promise.all(
        upgrades.map(function upgrade(template) {
          var current = DEFAULT_TEMPLATES.find(function byKey(def) {
            return def.key === template.key;
          });
          return EmailTemplate.updateOne({ _id: template._id, body: template.body }, { $set: { body: current.body } });
        })
      ).then(function afterUpgrade() {
        return Promise.all(
          missingTemplates.map(function createTemplate(template) {
            return EmailTemplate.create(template);
          })
        );
      });
    });
};

/**
 * Whether a key belongs to one of the built-in templates, which admins may
 * edit the contents of but must not rename or delete.
 *
 * @param {string} key - The template key to check.
 * @returns {boolean} True when the key is built in.
 */
emailTemplateSchema.statics.isBuiltInKey = function isBuiltInKey(key) {
  return BUILT_IN_KEYS.indexOf(String(key)) !== -1;
};

var EmailTemplate = mongoose.model("EmailTemplate", emailTemplateSchema);

EmailTemplate.BUILT_IN_KEYS = BUILT_IN_KEYS;

module.exports = EmailTemplate;
