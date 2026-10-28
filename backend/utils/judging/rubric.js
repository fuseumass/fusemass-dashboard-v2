"use strict";
/** @param {object} scores - Submitted scores. @param {Array<object>} criteria - Current rubric. @returns {boolean} Whether every score is valid. */
function validScores(scores, criteria) {
  return (
    !!scores &&
    typeof scores === "object" &&
    !Array.isArray(scores) &&
    Object.keys(scores).length === criteria.length &&
    criteria.every(function valid(c) {
      return (
        Object.prototype.hasOwnProperty.call(scores, c.key) &&
        Number.isInteger(scores[c.key]) &&
        scores[c.key] >= c.min &&
        scores[c.key] <= c.max
      );
    })
  );
}
/** @param {object} profile - Judge profile. @param {object} settings - Current configuration. @returns {boolean} Whether all rounds have valid scores. */
function calibrationDone(profile, settings) {
  return settings.calibrationProjects.every(function scored(project, index) {
    return profile.calibrationScores.some(function match(row) {
      return (
        row.round === index + 1 && validScores(row.scores, settings.criteria)
      );
    });
  });
}
module.exports = { validScores: validScores, calibrationDone: calibrationDone };
