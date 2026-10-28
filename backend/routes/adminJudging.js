"use strict";
var router = require("express").Router();
var multer = require("multer");
var controller = require("../controllers/adminJudgingController");
var isAdmin = require("../utils/isAdmin");
var requireFeature = require("../utils/requireFeature");
var upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 0 },
});
router.use(requireFeature("judging"));
var reports = require("../controllers/judgingResultsController");
var isModerator = require("../utils/isModerator");
router.get("/progress", isModerator, reports.progress);
router.get("/results", isAdmin, reports.results);
router.get("/progress.csv", isModerator, reports.exportCsv);
router.get("/results.csv", isAdmin, reports.exportCsv);
router.get("/scores.csv", isAdmin, reports.exportCsv);
var assignments = require("../controllers/judgingAssignmentController");
router.get("/assignments", isAdmin, assignments.list);
router.post("/assignments", isAdmin, assignments.generate);
router.post("/assignments/:version/activate", isAdmin, assignments.activate);
router.post("/assignments/judges", isAdmin, assignments.addJudge);
router.delete("/assignments/judges/:judgeId", isAdmin, assignments.removeJudge);
router.post("/projects/:id/withdraw", isAdmin, assignments.withdraw);
router.post("/close", isAdmin, assignments.setOpen);
router.post("/open", isAdmin, assignments.setOpen);
var calibration = require("../controllers/judgingCalibrationController");
router.get("/settings", isAdmin, calibration.getSettings);
router.patch("/settings", isAdmin, calibration.patchSettings);
router.get("/bias", isAdmin, calibration.getBias);
router.post("/bias", isAdmin, calibration.postBias);
var checkin = require("../controllers/judgingCheckinController");
router.get("/table-signs", isAdmin, checkin.tableSigns);
router.post("/bulk-assign", isAdmin, checkin.bulkAssign);
router.post("/projects/:id/undo-table", isAdmin, checkin.undo);
router.get("/rooms", isAdmin, controller.listRooms);
router.post("/rooms", isAdmin, controller.saveRoom);
router.patch("/rooms/:id", isAdmin, controller.saveRoom);
router.delete("/rooms/:id", isAdmin, controller.deleteRoom);
router.get("/projects", isAdmin, controller.listProjects);
router.patch("/projects/:id", isAdmin, controller.updateProject);
router.post(
  "/import",
  isAdmin,
  upload.single("file"),
  controller.previewImport,
);
router.post("/import/:id/confirm", isAdmin, controller.confirmImport);
/** @param {Error} err - Upload error. @param {object} req - Request. @param {object} res - Response. @param {function} next - Next middleware. @returns {void} */
function uploadError(err, req, res, next) {
  if (!(err instanceof multer.MulterError)) {
    next(err);
    return;
  }
  res
    .status(400)
    .json({
      error: "Upload one CSV file, at most 2 MB, using the file field.",
    });
}
router.use(uploadError);
module.exports = router;
