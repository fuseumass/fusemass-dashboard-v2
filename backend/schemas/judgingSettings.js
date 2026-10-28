"use strict";

var mongoose = require("mongoose");
/**
 * @typedef {object} JudgingSettings
 * @property {Array<object>} calibrationProjects - Ordered practice projects.
 * @property {Array<object>} criteria - Scoring rubric, with one category criterion.
 * @property {boolean} judgingOpen - Locks rubric configuration once opened.
 * @property {boolean} criteriaLocked - Remembers that judging has started.
 */
var schema = new mongoose.Schema(
  {
    key: { type: String, default: "default", unique: true, enum: ["default"] },
    judgingOpen: { type: Boolean, default: false },
    criteriaLocked: { type: Boolean, default: false },
    calibrationProjects: {
      type: [
        {
          _id: false,
          title: String,
          description: { type: String, default: "" },
          link: { type: String, default: "" },
        },
      ],
      default: function projects() {
        return [1, 2, 3].map(function project(n) {
          return { title: "Practice project " + n, description: "", link: "" };
        });
      },
    },
    criteria: {
      type: [
        {
          _id: false,
          key: String,
          label: String,
          help: String,
          min: Number,
          max: Number,
          weight: Number,
          kind: { type: String, enum: ["general", "category"] },
        },
      ],
      default: function criteria() {
        return [
          ["innovation", "Innovation", "How original is the idea?", 10],
          [
            "functionality",
            "Functionality",
            "How well does the project work?",
            10,
          ],
          [
            "practicality",
            "Practicality",
            "How useful and feasible is the project?",
            5,
          ],
          [
            "presentation",
            "Presentation",
            "How clearly was the project explained?",
            10,
          ],
          ["qa", "Q&A", "How well did the team answer questions?", 5],
          [
            "categoryFit",
            "Category fit",
            "How well does the project fit its category?",
            10,
          ],
        ].map(function criterion(row, i) {
          return {
            key: row[0],
            label: row[1],
            help: row[2],
            min: 0,
            max: row[3],
            weight: 1,
            kind: i === 5 ? "category" : "general",
          };
        });
      },
    },
  },
  { timestamps: true },
);
/** @param {object} [unused] - No arguments required. @returns {Promise<object>} Singleton settings. */
schema.statics.getSingleton = function getSingleton() {
  return this.findOneAndUpdate(
    { key: "default" },
    { $setOnInsert: { key: "default" } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
};
module.exports = mongoose.model("JudgingSettings", schema);
