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
/**
 * The practice projects a judge calibrates on: hardware judges have their own
 * list so they are compared with other hardware judges on hardware projects.
 * @param {object|null} profile - JudgeProfile (hardware flag).
 * @param {object} settings - JudgingSettings.
 * @returns {object[]} Ordered practice projects.
 */
function projectsFor(profile, settings) {
  return (profile && profile.hardware ? settings.hardwareCalibrationProjects : settings.calibrationProjects) || [];
}
function calibrationDone(profile, settings) {
  var projects = projectsFor(profile, settings);
  return projects.length > 0 && projects.every(function scored(project, index) {
    return profile.calibrationScores.some(function match(row) {
      return (
        row.round === index + 1 && validScores(row.scores, settings.criteria)
      );
    });
  });
}
module.exports = { validScores: validScores, calibrationDone: calibrationDone, projectsFor: projectsFor };
