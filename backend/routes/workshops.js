"use strict";
var router = require("express").Router();
var controller = require("../controllers/workshopController");
var isAuthenticated = require("../utils/isAuthenticated");
var requireFeature = require("../utils/requireFeature");
router.use(requireFeature("workshops"));
var raffle = require("../controllers/workshopRaffleController");
var manager = require("../utils/canManageWorkshop");
var rateLimit = require("express-rate-limit");
var limiter = rateLimit({
  windowMs: 60000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: function attemptKey(req) {
    return req.user.id + ":" + rateLimit.ipKeyGenerator(req.ip);
  },
  message: { error: "Too many attempts. Wait a minute before trying again." },
});
router.use(isAuthenticated, require("../utils/currentRole").requireRole(["applicant", "moderator", "admin"], "Judges cannot access attendee workshops."));
router.get("/manageable", raffle.manageable);
router.post("/:id/attendance/open", manager, raffle.session);
router.post("/:id/attendance/extend", manager, raffle.session);
router.post("/:id/attendance/close", manager, raffle.session);
router.get("/:id/attendance/code", manager, raffle.code);
router.post("/:id/attendance/staff", manager, raffle.staff);
router.get("/:id/attendance", manager, raffle.attendance);
router.get("/:id/attendance.csv", manager, raffle.attendance);
router.post("/:id/raffle/draw", manager, raffle.draw);
router.post(
  "/:id/raffle/:drawId/winners/:userId/claim",
  manager,
  raffle.winner,
);
router.post(
  "/:id/raffle/:drawId/winners/:userId/redraw",
  manager,
  raffle.winner,
);
router.get("/:id/raffle", manager, raffle.history);
router.use(controller.accepted);
router.get("/:id/me", raffle.me);
router.post("/:id/attendance", limiter, raffle.attend);
router.get("/", controller.list);
router.get("/mine", controller.list);
router.post("/:id/signup", controller.signup);
router.delete("/:id/signup", controller.cancelSignup);
module.exports = router;
