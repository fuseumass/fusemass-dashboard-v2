"use strict";

var HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * @param {string} value - Raw string to escape.
 * @returns {string} HTML-safe string.
 */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, function escapeChar(char) {
    return HTML_ESCAPES[char];
  });
}

/**
 * @param {string} template - Template content.
 * @param {object} values - Placeholder values to substitute.
 * @param {object} [options] - Rendering options.
 * @param {boolean} [options.escapeHtml] - HTML-escape substituted values (use
 *   when the result is rendered as HTML, e.g. an email's html body).
 * @returns {string} Rendered template.
 */
function renderTemplate(template, values, options) {
  if (!template) {
    return "";
  }

  var safeValues = values || {};
  var shouldEscape = Boolean(options && options.escapeHtml);

  return String(template).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, function replaceToken(match, key) {
    // Own properties only, so {{constructor}} etc. can't pull in Object.prototype.
    if (!Object.prototype.hasOwnProperty.call(safeValues, key)) {
      return "";
    }
    var value = safeValues[key];
    if (value === undefined || value === null) {
      return "";
    }
    var rendered = String(value);
    return shouldEscape ? escapeHtml(rendered) : rendered;
  });
}

module.exports = renderTemplate;
