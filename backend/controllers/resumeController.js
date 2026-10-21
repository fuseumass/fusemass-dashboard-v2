"use strict";

var mongoose = require("mongoose");

var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");
var azureBlob = require("../utils/azureBlob");

/**
 * Respond with a short-lived signed link to an application's resume, or the
 * matching error when there is nothing to link to. Callers must already have
 * checked that the requester is allowed to see this application.
 *
 * Responds `{ url, expiresAt }`. JSON rather than a redirect because the
 * frontend sends its JWT as a header, which a plain link click can't carry.
 *
 * @param {object|null} application - The Application document, or null if none was found.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function sendResumeLink(application, res) {
  if (!application || !application.resumeBlobName) {
    res.status(404).json({ error: "No resume on file." });
    return Promise.resolve();
  }
  if (!azureBlob.isAzureConfigured()) {
    res.status(501).json({ error: "Resume storage is not configured yet." });
    return Promise.resolve();
  }

  return azureBlob.getResumeLink(application.resumeBlobName).then(function afterSign(link) {
    res.status(200).json({ url: link.url, expiresAt: link.expiresAt });
  });
}

/**
 * GET /api/applications/me/resume
 * Signed link to the caller's own resume on their application for the open
 * round (the same application GET /api/applications/me returns).
 *
 * @param {object} req - Express request (req.user set by parseToken).
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function getMyResume(req, res) {
  var claims = req.user;
  if (!claims) {
    res.status(401).json({ error: "Authentication required." });
    return Promise.resolve();
  }

  return ApplicationRound.findOne({ isOpen: true })
    .sort({ order: 1 })
    .then(function afterRound(round) {
      if (!round) {
        return null;
      }
      return Application.findOne({ applicant: claims.id, round: round._id });
    })
    .then(function afterLookup(application) {
      return sendResumeLink(application, res);
    })
    .catch(function onError(err) {
      console.error("getMyResume failed:", err);
      res.status(500).json({ error: "Could not open your resume." });
    });
}

/**
 * GET /api/admin/applications/:id/resume
 * Signed link to any application's resume, for reviewers. Mounted behind
 * isModerator, so moderators and admins only.
 *
 * @param {object} req - Express request (req.params.id is the application id).
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function getApplicationResume(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ error: "Application not found." });
    return Promise.resolve();
  }

  return Application.findById(req.params.id)
    .then(function afterLookup(application) {
      if (!application) {
        res.status(404).json({ error: "Application not found." });
        return undefined;
      }
      return sendResumeLink(application, res);
    })
    .catch(function onError(err) {
      console.error("getApplicationResume failed:", err);
      res.status(500).json({ error: "Could not open this resume." });
    });
}

module.exports = {
  getMyResume: getMyResume,
  getApplicationResume: getApplicationResume,
};
