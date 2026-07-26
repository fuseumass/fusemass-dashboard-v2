"use strict";

var express = require("express");
var multer = require("multer");
var applicationController = require("../controllers/applicationController");
var isAuthenticated = require("../utils/isAuthenticated");

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
    cb(null, ok.indexOf(file.mimetype) !== -1);
  },
});

// Every application route requires the caller to be logged in.
// `upload.single("resume")` parses multipart/form-data: the file lands on
// req.file and the other fields on req.body.
router.post("/", isAuthenticated, upload.single("resume"), applicationController.apply);
router.get("/me", isAuthenticated, applicationController.getMine);

module.exports = router;
