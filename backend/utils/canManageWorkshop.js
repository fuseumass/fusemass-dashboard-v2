"use strict";
var mongoose = require("mongoose");
var Workshop = require("../schemas/workshop");
var currentRole = require("./currentRole").currentRole;
/** @param {object} req @param {object} res @param {function} next @returns {Promise<void>} */
async function canManageWorkshop(req, res, next) {
  try {
    if (!req.user)
      return res.status(401).json({ error: "Authentication required." });
    var role = await currentRole(req);
    if (!role)
      return res.status(401).json({ error: "Authentication required." });
    var staff = ["moderator", "admin"].indexOf(role) !== -1;
    // Assignment remains independent of role so B17 can add its role here later.
    if (
      !staff &&
      !(
        mongoose.isValidObjectId(req.params.id) &&
        (await Workshop.exists({ _id: req.params.id, organizers: req.user.id }))
      )
    ) {
      return res
        .status(403)
        .json({ error: "Workshop manager access required." });
    }
    if (!mongoose.isValidObjectId(req.params.id))
      return res.status(404).json({ error: "Workshop not found." });
    req.workshop = await Workshop.findOne({
      _id: req.params.id,
      cancelled: false,
    });
    if (!req.workshop)
      return res.status(404).json({ error: "Workshop not found." });
    next();
  } catch (err) {
    next(err);
  }
}
module.exports = canManageWorkshop;
