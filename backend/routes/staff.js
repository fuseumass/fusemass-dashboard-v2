"use strict";

const express = require("express");
const router = express.Router();

const staffController = require("../controllers/staffController");

const isAuthenticated = require("../utils/isAuthenticated");
const isModerator = require("../utils/isModerator");
const requireFeature = require("../utils/requireFeature");

// Event-day staff routes. Only authenticated admins or moderators may look up
// attendees, check them in, or read the check-in records.

// Meal check-in is feature-flagged: every /meals... route answers 404 for
// everyone while "meals" is switched off (B25).
router.use("/meals", requireFeature("meals"));

router.get(
    "/attendees",
    isAuthenticated,
    isModerator,
    staffController.searchAttendees
);

// Registered before /checkin/:userId so "stats" isn't read as a user id.
router.get(
    "/checkin/stats",
    isAuthenticated,
    isModerator,
    staffController.checkInStats
);

// Body: { qrId } (scanned) or { userId } (from the attendee search).
router.post(
    "/checkin",
    isAuthenticated,
    isModerator,
    staffController.checkInMark
);

router.get(
    "/checkin/:userId",
    isAuthenticated,
    isModerator,
    staffController.getCheckInStatus
);

router.get(
    "/meals",
    isAuthenticated,
    isModerator,
    staffController.listMealsForStaff
);

// Body: { qrId } (scanned) or { userId }.
router.post(
    "/meals/:mealId/checkin",
    isAuthenticated,
    isModerator,
    staffController.mealCheckInMark
);

// Attendee help: look someone up by email, resend their QR code email or an
// account setup / password reset link. (Forced check-in: POST /checkin.)
router.get(
    "/attendee",
    isAuthenticated,
    isModerator,
    staffController.lookupAttendee
);

router.post(
    "/attendee/resend-qr",
    isAuthenticated,
    isModerator,
    staffController.resendQrEmail
);

router.post(
    "/attendee/send-account-link",
    isAuthenticated,
    isModerator,
    staffController.sendAccountLink
);

module.exports = router;
