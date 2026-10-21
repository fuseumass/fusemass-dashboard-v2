"use strict";

var mongoose = require("mongoose");

var applicationStatus = require("./applicationStatus");

/**
 * Work out which applications an admin statistic or export covers, from the
 * query string: ?round=<id> limits it to one round, ?status=<status> to one
 * status. With no status, drafts are left out (they were never submitted).
 *
 * @param {object} query - req.query.
 * @returns {{error: string}|{match: object, round: string, status: string}}
 *   `match` is a MongoDB filter that works in find() and in $match alike
 *   (the round is already an ObjectId, which aggregation does not cast).
 */
function parseScope(query) {
  var round = query && query.round ? String(query.round) : "";
  var status = query && query.status ? String(query.status) : "";

  if (round && !mongoose.isValidObjectId(round)) {
    return { error: "round is not a valid id." };
  }
  if (status && applicationStatus.APPLICATION_STATUSES.indexOf(status) === -1) {
    return { error: "status must be one of: " + applicationStatus.APPLICATION_STATUSES.join(", ") + "." };
  }

  var match = { status: status || { $ne: "draft" } };
  if (round) {
    match.round = new mongoose.Types.ObjectId(round);
  }
  return { match: match, round: round, status: status };
}

/**
 * A form question label as plain text: "[text](https://...)" links become "text".
 * @param {*} label - Label as the form builder stored it.
 * @returns {string}
 */
function plainLabel(label) {
  return String(label || "").replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1");
}

module.exports = {
  parseScope: parseScope,
  plainLabel: plainLabel,
};
