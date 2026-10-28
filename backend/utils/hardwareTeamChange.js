"use strict";

var Checkout = require("../schemas/hardwareCheckout");
var Team = require("../schemas/team");
var User = require("../schemas/user");
var settingsCache = require("./orgSettingsCache");
var features = require("./features");
var returnBy = require("./hardwareReturnBy");
var mailer = require("./mailer");

/** @param {string|object} userId - Member whose membership changed. @returns {void} Starts background notification. */
function hardwareTeamChange(userId) {
  Promise.resolve().then(async function notify() {
    var settings = await settingsCache.get();
    if (!features.isEnabled(settings, "hardware")) return;
    var team = await Team.findOne({ members: userId }).select("name");
    var filter = { user: userId, returnedAt: null, teamChangeNotifiedAt: null, team: { $ne: team ? team._id : null } };
    var loans = await Checkout.find(filter).populate("item", "name");
    var claimed = [];
    for (var loan of loans) {
      var result = await Checkout.updateOne(Object.assign({}, filter, { _id: loan._id }), { $set: { teamChangeNotifiedAt: new Date() } });
      if (result.modifiedCount) claimed.push(loan);
    }
    if (!claimed.length) return;
    var user = await User.findById(userId).select("name email");
    if (!user) return;
    await mailer.sendTemplateEmail(user.email, "hardware_team_change", {
      name: user.name, newTeam: team ? team.name : "no team", returnBy: returnBy(settings),
      items: claimed.map(function line(loan) { return "- " + (loan.item ? loan.item.name : "Archived item") + " (checked out with " + (loan.teamName || "no team") + ")"; }).join("\n")
    });
  }).catch(function failed(err) { console.error("Hardware team change email failed:", err); });
}
module.exports = hardwareTeamChange;
