"use strict";

/**
 * @param {string} template - Template content.
 * @param {object} values - Placeholder values to substitute.
 * @returns {string} Rendered template.
 */
function renderTemplate(template, values) {
  if (!template) {
    return "";
  }

  var safeValues = values || {};
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, function replaceToken(match, key) {
    var value = safeValues[key];
    if (value === undefined || value === null) {
      return "";
    }
    return String(value);
  });
}

module.exports = renderTemplate;
