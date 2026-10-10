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
      "Hi {{name}},\n\nCongratulations! Your application to {{orgName}} has been accepted.\n\nStatus: {{status}}.\n\nShow the QR code below when you arrive at check-in: {{qrcode}}",
  },
  {
    key: "application_rejected",
    subject: "Your application to {{orgName}} was not selected",
    body:
      "Hi {{name}},\n\nThank you for applying to {{orgName}}. After review, your application was not selected.\n\nStatus: {{status}}",
  },
];

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

module.exports = mongoose.model("EmailTemplate", emailTemplateSchema);
