"use strict";
var Settings = require("../../schemas/judgingSettings");

/**
 * The live scoring rubric from JudgingSettings (admin-editable until judging
 * opens), as plain objects.
 * @returns {Promise<object[]>} Criteria: key, label, help, min, max, weight, kind.
 */
async function getCriteria() {
  var settings = await Settings.getSingleton();
  return settings.criteria.map(function plain(c) {
    return { key: c.key, label: c.label, help: c.help, min: c.min, max: c.max, weight: c.weight, kind: c.kind };
  });
}
module.exports = { getCriteria: getCriteria };
