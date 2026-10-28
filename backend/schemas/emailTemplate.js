"use strict";

var mongoose = require("mongoose");

var Schema = mongoose.Schema;

var DEFAULT_TEMPLATES = [
  {
    // Sent when an attendee signs up for a workshop, with a calendar invite.
    key: "workshop_signup",
    subject: "You're signed up: {{title}}",
    body:
      "Hi {{name}},\n\nYou're signed up for {{title}}.\n\nWhen: {{when}}\nWhere: {{location}}\n\nThe calendar invite is attached. To cancel, use the Workshops page on your dashboard.",
  },
  {
    // Sent to everyone signed up when a workshop's time or place changes. The
    // attached invite updates the one already in their calendar.
    key: "workshop_changed",
    subject: "New time or place: {{title}}",
    body:
      "Hi {{name}},\n\n{{title}} has a new time or place.\n\nWhen: {{when}}\nWhere: {{location}}\n\nThe attached invite updates the one already in your calendar.",
  },
  {
    // Sent when an attendee cancels, or an admin cancels the workshop. The
    // attachment removes it from their calendar.
    key: "workshop_cancelled",
    subject: "Cancelled: {{title}}",
    body:
      "Hi {{name}},\n\nYou're no longer signed up for {{title}} ({{when}}).\n\nThe attachment removes it from your calendar.",
  },
  {
    // Sent to each raffle winner; {{organizerRoom}} comes from org settings.
    key: "raffle_winner",
    subject: "You won a raffle at {{title}}",
    body: "Hi {{name}},\n\nYou won {{prize}} in the raffle at {{title}}.\n\nCollect it from {{organizerRoom}} after the workshop. Bring your dashboard QR code.",
  },
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
      "Hi {{name}},\n\nYour application to {{orgName}} has been accepted.\n\nStatus: {{status}}\n\nThis QR code is your pass for event check-in and meals. Keep this email handy (it is also on your dashboard):\n\n{{qrcode}}",
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
    subject: "You're checked in to {{orgName}}",
    body:
      "Hi {{name}},\n\nYou're checked in to {{orgName}}.\n\nIf you haven't joined our Discord yet, join now. It's where announcements, mentors and team-finding happen: {{discordUrl}}\n\n{{runOfShow}}\n\nSchedule updates, FAQs, maps and prizes are on our website: {{websiteUrl}}",
  },
];

// Earlier defaults of built-in templates. Seeding upgrades subjects and
// bodies independently when they still exactly match an older default.
// Customized text is preserved, including when only the other field changes.
var LEGACY_DEFAULT_SUBJECTS = {
  checked_in: ["You're checked in to {{orgName}}!"],
};

var LEGACY_DEFAULT_BODIES = {
  checked_in: [
    "Hi {{name}},\n\nYou're checked in to {{orgName}}. Welcome!\n\nIf you haven't joined our Discord yet, join now. It's where announcements, mentors and team-finding happen: {{discordUrl}}\n\n{{runOfShow}}\n\nSchedule updates, FAQs, maps and prizes are on our website: {{websiteUrl}}\n\nHappy hacking!",
  ],
  application_accepted: [
    "Hi {{name}},\n\nCongratulations! Your application to {{orgName}} has been accepted.\n\nStatus: {{status}}\n\nThis QR code is your pass for event check-in and meals. Keep this email handy (it is also on your dashboard):\n\n{{qrcode}}",
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
    .select("key body subject")
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
        var subjects = LEGACY_DEFAULT_SUBJECTS[template.key] || [];
        return legacy.indexOf(template.body) !== -1 || subjects.indexOf(template.subject) !== -1;
      });

      return Promise.all(
        upgrades.map(function upgrade(template) {
          var current = DEFAULT_TEMPLATES.find(function byKey(def) {
            return def.key === template.key;
          });
          var filter = { _id: template._id };
          var updates = {};
          if ((LEGACY_DEFAULT_BODIES[template.key] || []).indexOf(template.body) !== -1) {
            filter.body = template.body;
            updates.body = current.body;
          }
          if ((LEGACY_DEFAULT_SUBJECTS[template.key] || []).indexOf(template.subject) !== -1) {
            filter.subject = template.subject;
            updates.subject = current.subject;
          }
          return EmailTemplate.updateOne(filter, { $set: updates });
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
