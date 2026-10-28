"use strict";
/** @param {void} unused - No input. @returns {object[]} Default rubric, ready for the settings adapter. */
function getCriteria() {
  return [
    ["innovation", "Innovation", "How original is the idea and approach?", 10],
    ["functionality", "Functionality", "How well does the demonstrated project work?", 10],
    ["practicality", "Practicality", "How useful and feasible is the solution?", 5],
    ["presentation", "Presentation", "How clearly does the team explain their work?", 10],
    ["qa", "Q&A", "How well does the team answer questions?", 5],
    ["categoryFit", "Category fit", "How well does the project address its category?", 10],
  ].map(function criterion(row) {
    return { key: row[0], label: row[1], help: row[2], min: 0, max: row[3], weight: 1,
      kind: row[0] === "categoryFit" ? "category" : "general" };
  });
}
module.exports = { getCriteria: getCriteria };
