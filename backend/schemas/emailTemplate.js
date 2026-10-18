"use strict";

var mongoose = require("mongoose");

var Schema = mongoose.Schema;

var DEFAULT_TEMPLATES = [
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
    // Sent when staff check an attendee in on arrival. The run of show is
    // also attached as a calendar invite.
    key: "checked_in",
    subject: "You're checked in to {{orgName}}!",
    body:
      "Hi {{name}},\n\nYou're checked in to {{orgName}}. Welcome!\n\nIf you haven't joined our Discord yet, join now. It's where announcements, mentors and team-finding happen: {{discordUrl}}\n\n{{runOfShow}}\n\nSchedule updates, FAQs, maps and prizes are on our website: {{websiteUrl}}\n\nHappy hacking!",
  },
];

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
 * Seed the built-in templates if they have not been added already.
 *
 * @returns {Promise<Array<object>>} The newly created templates.
 */
emailTemplateSchema.statics.seedDefaults = function seedDefaults() {
  var EmailTemplate = this;

  return EmailTemplate.find({})
    .select("key")
    .lean()
    .then(function afterFind(existingTemplates) {
      var existingKeys = existingTemplates.map(function mapKey(template) {
        return template.key;
      });
      var missingTemplates = DEFAULT_TEMPLATES.filter(function filterTemplate(template) {
        return existingKeys.indexOf(template.key) === -1;
      });

      if (!missingTemplates.length) {
        return [];
      }

      return Promise.all(
        missingTemplates.map(function createTemplate(template) {
          return EmailTemplate.create(template);
        })
      );
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
