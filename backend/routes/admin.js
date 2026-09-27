"use strict";

var express = require("express");
var adminController = require("../controllers/adminController");
var settingsController = require("../controllers/settingsController");
var isAdmin = require("../utils/isAdmin");
var isModerator = require("../utils/isModerator");

var router = express.Router();

// ---- Reviewer routes: moderators OR admins ---------------------------------
// Moderators can review applications (approve/reject) and list them.
router.get("/applications", isModerator, adminController.listApplications);
router.patch("/applications/:id", isModerator, adminController.decideApplication);

// ---- Admin-only routes: organization setup ---------------------------------
// User management (promote to moderator/admin).
router.get("/users", isAdmin, adminController.searchUsers);
router.patch("/users/:id/role", isAdmin, adminController.setRole);

// Application rounds (multiple application cycles + their dates + form config).
router.get("/rounds", isAdmin, adminController.listRounds);
router.post("/rounds", isAdmin, adminController.createRound);
router.patch("/rounds/:id", isAdmin, adminController.updateRound);
router.delete("/rounds/:id", isAdmin, adminController.deleteRound);

// Email templates.
router.get("/email-templates", isAdmin, adminController.listEmailTemplates);
router.post("/email-templates", isAdmin, adminController.createEmailTemplate);
router.patch("/email-templates/:id", isAdmin, adminController.updateEmailTemplate);
router.delete("/email-templates/:id", isAdmin, adminController.deleteEmailTemplate);

// Org settings (e.g. Google OAuth toggle).
router.get("/settings", isAdmin, settingsController.getSettings);
router.patch("/settings", isAdmin, settingsController.updateSettings);

// Meal services (event-day food service administration).
router.get("/meals", isAdmin, adminController.listMeals);
router.post("/meals", isAdmin, adminController.createMeal);
router.patch("/meals/:id", isAdmin, adminController.updateMeal);
router.delete("/meals/:id", isAdmin, adminController.deleteMeal);

module.exports = router;
