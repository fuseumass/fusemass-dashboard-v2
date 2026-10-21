"use strict";

var express = require("express");
var multer = require("multer");
var applicationController = require("../controllers/applicationController");
var resumeController = require("../controllers/resumeController");
var isAuthenticated = require("../utils/isAuthenticated");
var authRateLimit = require("../utils/authRateLimit");

var router = express.Router();

// Keep the uploaded resume in memory; the controller streams it to Azure Blob.
// Cap at 5 MB and only accept common resume formats.
var upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: function fileFilter(_req, file, cb) {
    var ok = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    if (ok.indexOf(file.mimetype) === -1) {
      cb(new Error("Resume must be a PDF or Word document."));
      return;
    }
    cb(null, true);
  },
});

/**
 * Translate multer's upload errors (oversized file, rejected type from
 * fileFilter above) into a clean 400 instead of falling through to the
 * generic 500 handler. Express 4 error middleware: 4 args is what makes it
 * an error handler, so this must stay right after upload.single() below.
 *
 * @param {Error} err - Error from multer (or fileFilter's custom Error).
 * @param {object} _req - Express request.
 * @param {object} res - Express response.
 * @param {function} next - Express next callback.
 * @returns {void}
 */
function handleUploadError(err, _req, res, next) {
  if (!err) {
    next();
    return;
  }
  if (err.code === "LIMIT_FILE_SIZE") {
    res.status(400).json({ error: "Resume must be 5 MB or smaller." });
    return;
  }
  res.status(400).json({ error: err.message || "Could not process the uploaded file." });
}

// Applying without an account, when admins enable it (404 otherwise). The
// rate limit runs before multer so a flood never gets as far as uploading.
router.get("/public/round", applicationController.getPublicRound);
router.post(
  "/public",
  authRateLimit.publicApply,
  upload.single("resume"),
  handleUploadError,
  applicationController.applyPublic
);

// Every other application route requires the caller to be logged in.
// `upload.single("resume")` parses multipart/form-data: the file lands on
// req.file and the other fields on req.body.
router.post("/", isAuthenticated, upload.single("resume"), handleUploadError, applicationController.apply);
router.get("/me", isAuthenticated, applicationController.getMine);
router.get("/me/qr", isAuthenticated, applicationController.getMyQr);
router.get("/me/resume", isAuthenticated, resumeController.getMyResume);

module.exports = router;
