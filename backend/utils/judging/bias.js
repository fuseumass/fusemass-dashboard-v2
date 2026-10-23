"use strict";

/**
 * Reproduce the calibration formula: mean of per-round differences from the
 * participating judges' mean. General criteria are averaged before judges.
 * Missing criteria/rounds are excluded, never treated as zero.
 * @param {object} tutorialScoresByJudge - Judge ID -> array of score objects.
 * @param {object} [rubric] - {general: [score keys], category: score key}.
 * Defaults to score1..score5 and score6, as in the original platform.
 * @returns {object} Judge ID -> {general, category}; no calibration yields null.
 */
function computeBias(tutorialScoresByJudge, rubric) {
  rubric = rubric || {
    general: ["score1", "score2", "score3", "score4", "score5"],
    category: "score6"
  };
  var result = {};
  var ids = Object.keys(tutorialScoresByJudge);
  ids.forEach(function judge(id) {
    var rounds = tutorialScoresByJudge[id] || [];
    if (!rounds.length) {
      result[id] = null;
      return;
    }
    var generalBiases = [];
    var categoryBiases = [];
    rounds.forEach(function round(scores, index) {
      var generalAverages = [];
      var categoryScores = [];
      ids.forEach(function peer(peerId) {
        var peerRounds = tutorialScoresByJudge[peerId] || [];
        if (peerRounds.length <= index) return;
        var peerScores = peerRounds[index];
        var general = generalMean(peerScores, rubric.general);
        if (general !== null) generalAverages.push(general);
        if (peerScores[rubric.category] != null) categoryScores.push(peerScores[rubric.category]);
      });
      var ownGeneral = generalMean(scores, rubric.general);
      if (ownGeneral !== null && generalAverages.length) {
        generalBiases.push(ownGeneral - mean(generalAverages));
      }
      if (scores[rubric.category] != null && categoryScores.length) {
        categoryBiases.push(scores[rubric.category] - mean(categoryScores));
      }
    });
    result[id] = { general: mean(generalBiases), category: mean(categoryBiases) };
  });
  return result;
}

function mean(values) {
  return values.length ? values.reduce(function sum(a, b) { return a + b; }, 0) / values.length : 0;
}

function generalMean(scores, keys) {
  var values = keys.map(function score(key) { return scores[key]; })
    .filter(function present(value) { return value != null; });
  return values.length ? mean(values) : null;
}

module.exports = { computeBias: computeBias };
