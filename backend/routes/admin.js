"use strict";

var express = require("express");
var multer = require("multer");
var adminController = require("../controllers/adminController");
var resumeController = require("../controllers/resumeController");
var teamController = require("../controllers/teamController");
var settingsController = require("../controllers/settingsController");
var scheduleController = require("../controllers/scheduleController");
var brandingController = require("../controllers/brandingController");
var statsController = require("../controllers/statsController");
var exportRoutes = require("./exports");
var isAdmin = require("../utils/isAdmin");
var isModerator = require("../utils/isModerator");
var requireFeature = require("../utils/requireFeature");
var validateBody = require("../utils/validateBody");
var applicationStatus = require("../utils/applicationStatus");

var router = express.Router();

// Logo / favicon uploads: kept in memory (capped at 1 MiB) and handed to the
// branding controller, which checks the real image type from the bytes.
var imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: brandingController.MAX_IMAGE_BYTES, files: 1 },
});

/**
 * Turn multer's upload errors (file too large, unexpected field) into a clean
 * 400. Express 4 error middleware: the 4 arguments are what mark it as one.
 * @param {Error} err - Error from multer.
 * @param {object} _req - Express request.
 * @param {object} res - Express response.
 * @param {function} next - Express next callback.
 * @returns {void}
 */
function handleImageUploadError(err, _req, res, next) {
  if (!err) {
    next();
    return;
  }
  if (err.code === "LIMIT_FILE_SIZE") {
    res.status(400).json({ error: "The image must be 1 MB or smaller." });
    return;
  }
  res.status(400).json({ error: "Could not read the uploaded file. Send it as the form field \"file\"." });
}

// ---- Reviewer routes: moderators OR admins ---------------------------------
// Moderators can review applications (approve/reject) and list them.
router.get("/applications", isModerator, adminController.listApplications);
router.get("/applications/:id", isModerator, adminController.getApplication);
router.patch(
  "/applications/:id",
  isModerator,
  validateBody({
    decision: { required: true, type: "string", enum: applicationStatus.DECISION_STATUSES },
  }),
  adminController.decideApplication
);
// Resumes live in a private container; this hands out a short-lived signed link.
router.get("/applications/:id/resume", isModerator, resumeController.getApplicationResume);
// Every team with members and Devpost links (staff view, judging matching).
router.get("/teams", isModerator, teamController.listAllTeams);

// ---- Admin-only routes: organization setup ---------------------------------
// User management (promote to moderator/admin).
router.get("/users", isAdmin, adminController.searchUsers);
router.patch(
  "/users/:id/role",
  isAdmin,
  validateBody({
    role: { required: true, type: "string", enum: ["applicant", "moderator", "admin"] },
  }),
  adminController.setRole
);

// Application rounds (multiple application cycles + their dates + form config).
router.get("/rounds", isAdmin, adminController.listRounds);
router.post(
  "/rounds",
  isAdmin,
  validateBody({ name: { required: true, type: "string" } }),
  adminController.createRound
);
router.patch("/rounds/:id", isAdmin, adminController.updateRound);
router.delete("/rounds/:id", isAdmin, adminController.deleteRound);

// Email templates.
router.get("/email-templates", isAdmin, adminController.listEmailTemplates);
router.post(
  "/email-templates",
  isAdmin,
  validateBody({ key: { required: true, type: "string" } }),
  adminController.createEmailTemplate
);
// Preview / test-send take the unsaved draft `{ subject, body }` from the
// editor (or use the stored template :id). Registered before /:id routes.
router.post("/email-templates/preview", isAdmin, adminController.previewEmailTemplate);
router.post("/email-templates/test", isAdmin, adminController.sendTestEmailTemplate);
router.post("/email-templates/:id/test", isAdmin, adminController.sendTestEmailTemplate);
router.patch("/email-templates/:id", isAdmin, adminController.updateEmailTemplate);
router.delete("/email-templates/:id", isAdmin, adminController.deleteEmailTemplate);

// Org settings (e.g. Google OAuth toggle).
router.get("/settings", isAdmin, settingsController.getSettings);
router.patch("/settings", isAdmin, settingsController.updateSettings);

// Logo / dark logo / favicon (slot = logo | logo-dark | favicon). Multipart
// field "file"; isAdmin runs first so only admins can make us buffer an upload.
router.put("/branding/:slot", isAdmin, imageUpload.single("file"), handleImageUploadError, brandingController.uploadImage);
router.delete("/branding/:slot", isAdmin, brandingController.removeImage);

// Meal services (event-day food service administration). Feature-flagged:
// 404 for everyone while "meals" is switched off (B25).
router.use("/meals", requireFeature("meals"));
router.get("/meals", isAdmin, adminController.listMeals);
router.post("/meals", isAdmin, adminController.createMeal);
router.patch("/meals/:id", isAdmin, adminController.updateMeal);
router.delete("/meals/:id", isAdmin, adminController.deleteMeal);

// Run of show (emailed to attendees as a calendar invite when they check in).
router.get("/schedule", isAdmin, scheduleController.listScheduleEvents);
router.post("/schedule", isAdmin, scheduleController.createScheduleEvent);
router.patch("/schedule/:id", isAdmin, scheduleController.updateScheduleEvent);
router.delete("/schedule/:id", isAdmin, scheduleController.deleteScheduleEvent);

// Statistics for the admin Statistics page (counts only, computed in MongoDB).
router.get("/stats", isAdmin, statsController.getStats);

// CSV / ZIP exports of applications, check-ins, meals and sponsor resumes.
router.use("/exports", exportRoutes);

module.exports = router;
