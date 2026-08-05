"use strict";

/**
 * Build an Express middleware that validates req.body against a small
 * declarative schema before the request reaches a controller, replacing the
 * repeated "check required fields, 400 on bad input" boilerplate that used
 * to be hand-rolled at the top of each controller.
 *
 * Schema shape, keyed by field name:
 *   {
 *     required?: boolean,
 *     type?: "string" | "number" | "boolean",
 *     enum?: Array<*>,
 *     minLength?: number,
 *   }
 *
 * Only checks presence/shape — business-logic checks (does this email
 * already exist, is this token expired, ...) stay in the controller.
 *
 * @param {object} schema - Field rules, keyed by field name.
 * @returns {function} Express middleware (req, res, next).
 */
function validateBody(schema) {
  return function validate(req, res, next) {
    var body = req.body || {};
    var errors = [];

    Object.keys(schema).forEach(function checkField(field) {
      var rule = schema[field] || {};
      var value = body[field];
      var isEmpty = value === undefined || value === null || value === "";

      if (rule.required && isEmpty) {
        errors.push(field + " is required.");
        return;
      }

      if (isEmpty) {
        return;
      }

      if (rule.type === "string" && typeof value !== "string") {
        errors.push(field + " must be a string.");
      } else if (rule.type === "number" && typeof value !== "number" && Number.isNaN(Number(value))) {
        errors.push(field + " must be a number.");
      } else if (rule.type === "boolean" && typeof value !== "boolean") {
        errors.push(field + " must be a boolean.");
      }

      if (rule.enum && rule.enum.indexOf(value) === -1) {
        errors.push(field + " must be one of: " + rule.enum.join(", ") + ".");
      }

      if (rule.minLength && typeof value === "string" && value.length < rule.minLength) {
        errors.push(field + " must be at least " + rule.minLength + " characters.");
      }
    });

    if (errors.length) {
      res.status(400).json({ error: errors.join(" ") });
      return;
    }

    next();
  };
}

module.exports = validateBody;
