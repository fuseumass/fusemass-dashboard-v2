"use strict";

/**
 * For each judge, G = sum(weight * score) over general criteria and C is
 * the same sum over category criteria. Raw totals are means of G and C.
 * Adjusted totals are mean(G - bias.general * Wg), mean(C - bias.category * Wc),
 * where Wg and Wc are the summed weights of the general and category criteria.
 * Calibration bias (utils/judging/bias.js) is measured per criterion point
 * (the judge's mean general score minus everyone's), so it is scaled by the
 * weights to match G and C. Missing bias contributes zero and raises
 * noCalibration.
 * Empty projects have null totals/ranks. Competition ranks (1, 1, 3) use
 * adjusted totals, overall by general and within category by category score.
 * Withdrawn projects retain totals for audit but receive no rank.
 * @param {object[]} projects - Projects with ids and category.
 * @param {object[]} scores - Unique judge/project scores, plain objects or Maps.
 * @param {object[]} criteria - Live weighted rubric.
 * @param {object} biases - Judge id to {general, category}, or null.
 * @param {number} judgingsPerProject - Expected score coverage.
 * @returns {object[]} Project totals, flags and ranks, sorted by overall rank.
 */
function computeResults(projects, scores, criteria, biases, judgingsPerProject) {
  var grouped = new Map();
  scores.forEach(function group(s) {
    var id = String(s.project);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(s);
  });
  var weights = { general: 0, category: 0 };
  criteria.forEach(function weigh(c) { weights[c.kind === "general" ? "general" : "category"] += c.weight; });
  var rows = projects.map(function project(p) {
    var entries = grouped.get(String(p._id)) || [];
    var totals = { rawGeneral: 0, adjustedGeneral: 0, rawCategory: 0, adjustedCategory: 0 };
    var uncalibratedJudges = [];
    entries.forEach(function score(s) {
      var general = 0;
      var category = 0;
      criteria.forEach(function criterion(c) {
        var value = s.scores instanceof Map ? s.scores.get(c.key) : s.scores[c.key];
        if (c.kind === "general") general += value * c.weight;
        else category += value * c.weight;
      });
      var bias = biases[String(s.judge)];
      var calibrated = bias && Number.isFinite(bias.general) && Number.isFinite(bias.category);
      if (!calibrated) uncalibratedJudges.push(String(s.judge));
      totals.rawGeneral += general;
      totals.rawCategory += category;
      totals.adjustedGeneral += general - (calibrated ? bias.general * weights.general : 0);
      totals.adjustedCategory += category - (calibrated ? bias.category * weights.category : 0);
    });
    Object.keys(totals).forEach(function average(key) { totals[key] = entries.length ? totals[key] / entries.length : null; });
    return Object.assign({ _id: String(p._id), name: p.name, category: p.category || "", tableNumber: p.tableNumber,
      withdrawn: Boolean(p.withdrawn), scoreCount: entries.length, uncalibratedJudges: uncalibratedJudges,
      flags: { missingScores: entries.length < judgingsPerProject, noCalibration: uncalibratedJudges.length > 0 },
      overallRank: null, categoryRank: null }, totals);
  });
  function rank(list, key, target) {
    list.sort(function order(a, b) { return b[key] - a[key] || a._id.localeCompare(b._id); });
    list.forEach(function assign(row, i) { row[target] = i && row[key] === list[i - 1][key] ? list[i - 1][target] : i + 1; });
  }
  var eligible = rows.filter(function scored(p) { return p.scoreCount && !p.withdrawn; });
  rank(eligible.slice(), "adjustedGeneral", "overallRank");
  new Set(eligible.map(function category(p) { return p.category; })).forEach(function category(name) {
    rank(eligible.filter(function same(p) { return p.category === name; }), "adjustedCategory", "categoryRank");
  });
  return rows.sort(function order(a, b) { return (a.overallRank || Infinity) - (b.overallRank || Infinity) || a._id.localeCompare(b._id); });
}
module.exports = { computeResults: computeResults };
