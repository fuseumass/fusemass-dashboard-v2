"use strict";

const mongoose = require("mongoose");

const User = require("../schemas/user");
const Application = require("../schemas/application");
const CheckIn = require("../schemas/checkin");
const MealService = require("../schemas/mealService");
const MealCheckIn = require("../schemas/mealCheckin");
const qrCode = require("../utils/qrCode");

// Event-day staff endpoints (moderators + admins): the first check-in, meal
// check-ins, and the attendee search used when someone can't show their QR.
//
// Every check-in accepts the attendee either as a scanned `qrId` (the code on
// their acceptance email, see utils/qrCode) or as a `userId` (picked from the
// search). Both go through resolveAttendee, so the "must be accepted" rule
// lives in one place.

/**
 * @param {string} value - User input to embed in a regular expression.
 * @returns {string} The input with regex metacharacters escaped.
 */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The attendee fields staff see after a scan, to confirm the code belongs to
 * the person in front of them.
 * @param {object} user - User document.
 * @param {object} [application] - Their accepted application.
 * @returns {{id: string, name: string, email: string}}
 */
function attendeeSummary(user, application) {
  return {
    id: String(user._id),
    name: (application && application.name) || user.name,
    email: user.email,
  };
}

/**
 * Find the accepted attendee a check-in request refers to.
 * @param {object} body - Request body with `qrId` or `userId`.
 * @returns {Promise<object>} `{ user, application }` on success, or
 *   `{ status, error }` describing why the request can't proceed.
 */
async function resolveAttendee(body) {
  const rawQrId = body && body.qrId;
  const userId = body && body.userId;
  let user = null;

  if (rawQrId) {
    const qrId = qrCode.normalizeQrId(rawQrId);
    if (!qrId) {
      return { status: 400, error: "That is not a valid check-in QR code." };
    }
    user = await User.findOne({ qrId: qrId });
    if (!user) {
      return { status: 404, error: "No attendee matches this QR code." };
    }
  } else if (userId) {
    if (!mongoose.isValidObjectId(userId)) {
      return { status: 400, error: "userId is not valid." };
    }
    user = await User.findById(userId);
    if (!user) {
      return { status: 404, error: "User not found." };
    }
  } else {
    return { status: 400, error: "qrId or userId is required." };
  }

  const application = await Application.findOne({ applicant: user._id, status: "accepted" });
  if (!application) {
    return {
      status: 400,
      error: user.name + "'s application has not been accepted or does not exist.",
    };
  }

  return { user: user, application: application };
}

/**
 * Answer a repeat check-in with 409 and when/by whom it first happened.
 * @param {object} res - Express response.
 * @param {object} attendee - attendeeSummary() of the attendee.
 * @param {object} record - The existing CheckIn / MealCheckIn (checkedInBy populated).
 * @param {string} message - Error message.
 * @returns {void}
 */
function sendAlreadyCheckedIn(res, attendee, record, message) {
  res.status(409).json({
    error: message,
    attendee: attendee,
    checkedInAt: record.checkedInAt,
    checkedInBy: record.checkedInBy && record.checkedInBy.name ? record.checkedInBy.name : null,
  });
}

//  GET /api/staff/attendees?q=
/**
 * Search accepted attendees by name or email (the fallback for anyone without
 * their QR code). Returns up to 25, each with their check-in status.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
async function searchAttendees(req, res) {
  try {
    const q = req.query && req.query.q ? String(req.query.q).trim() : "";

    const applications = await Application.find({ status: "accepted" }).select("applicant name").lean();
    const nameByUser = {};
    applications.forEach(function addApplicant(application) {
      nameByUser[String(application.applicant)] = application.name || nameByUser[String(application.applicant)];
    });

    const userFilter = { _id: { $in: Object.keys(nameByUser) } };
    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      const matchedByApplicationName = Object.keys(nameByUser).filter(function matches(id) {
        return rx.test(nameByUser[id] || "");
      });
      userFilter.$or = [{ name: rx }, { email: rx }, { _id: { $in: matchedByApplicationName } }];
    }

    const users = await User.find(userFilter).select("name email").sort({ name: 1 }).limit(25);
    const checkIns = await CheckIn.find({
      user: {
        $in: users.map(function pickId(user) {
          return user._id;
        }),
      },
    }).populate("checkedInBy", "name");

    const checkInByUser = {};
    checkIns.forEach(function addCheckIn(checkIn) {
      checkInByUser[String(checkIn.user)] = checkIn;
    });

    return res.json({
      attendees: users.map(function toAttendee(user) {
        const checkIn = checkInByUser[String(user._id)];
        return Object.assign(attendeeSummary(user, { name: nameByUser[String(user._id)] }), {
          checkedIn: Boolean(checkIn),
          checkedInAt: checkIn ? checkIn.checkedInAt : null,
          checkedInBy: checkIn && checkIn.checkedInBy ? checkIn.checkedInBy.name : null,
        });
      }),
    });
  } catch (err) {
    console.error("searchAttendees failed:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

//  POST /api/staff/checkin
/**
 * Mark an accepted attendee as checked in to the event (once per attendee).
 * Body: { qrId } from a scan, or { userId } from the search.
 * @param {object} req - Express request (req.user set by parseToken).
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
async function checkInMark(req, res) {
  try {
    const found = await resolveAttendee(req.body);
    if (found.error) {
      return res.status(found.status).json({ error: found.error });
    }

    const attendee = attendeeSummary(found.user, found.application);
    const alreadyMessage = attendee.name + " is already checked in.";

    const existing = await CheckIn.findOne({ user: found.user._id }).populate("checkedInBy", "name");
    if (existing) {
      return sendAlreadyCheckedIn(res, attendee, existing, alreadyMessage);
    }

    let checkIn;
    try {
      checkIn = await CheckIn.create({
        user: found.user._id,
        checkedInBy: req.user.id,
      });
    } catch (err) {
      // Two scans of the same code at once: the unique index let only one in.
      if (err && err.code === 11000) {
        const winner = await CheckIn.findOne({ user: found.user._id }).populate("checkedInBy", "name");
        return sendAlreadyCheckedIn(res, attendee, winner, alreadyMessage);
      }
      throw err;
    }

    return res.status(201).json({
      success: true,
      attendee: attendee,
      checkIn: checkIn,
    });
  } catch (err) {
    console.error("checkInMark failed:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

//   GET /api/staff/checkin/:userId
/**
 * Whether a user has checked in; if so, when and who checked them in.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
async function getCheckInStatus(req, res) {
  try {
    if (!mongoose.isValidObjectId(req.params.userId)) {
      return res.status(400).json({ error: "userId is not valid." });
    }

    const checkIn = await CheckIn.findOne({
      user: req.params.userId,
    }).populate("checkedInBy", "name");

    if (!checkIn) {
      return res.json({
        checkedIn: false,
      });
    }

    return res.json({
      checkedIn: true,
      checkedInAt: checkIn.checkedInAt,
      checkedInBy: checkIn.checkedInBy,
    });
  } catch (err) {
    console.error("getCheckInStatus failed:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

//  GET /api/staff/meals
/**
 * List meal services (with how many have been served) so staff can pick
 * which one they are checking attendees into.
 * @param {object} _req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
async function listMealsForStaff(_req, res) {
  try {
    const meals = await MealService.find({}).sort({ startsAt: 1, createdAt: 1 });
    const counts = await MealCheckIn.countsByMeal();
    return res.json({
      meals: meals.map(function withCount(meal) {
        return Object.assign(meal.toJSON(), { checkInCount: counts[String(meal._id)] || 0 });
      }),
    });
  } catch (err) {
    console.error("listMealsForStaff failed:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

//  POST /api/staff/meals/:mealId/checkin
/**
 * Record that an accepted attendee was served an (active) meal service. Each
 * attendee can be checked in once per meal, which prevents double serving.
 * Body: { qrId } from a scan, or { userId }.
 * @param {object} req - Express request (req.user set by parseToken).
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
async function mealCheckInMark(req, res) {
  try {
    const mealId = req.params.mealId;
    const meal = mongoose.isValidObjectId(mealId) ? await MealService.findById(mealId) : null;
    if (!meal) {
      return res.status(404).json({ error: "Meal service not found." });
    }
    if (!meal.active) {
      return res.status(400).json({ error: meal.name + " is not active." });
    }

    const found = await resolveAttendee(req.body);
    if (found.error) {
      return res.status(found.status).json({ error: found.error });
    }

    const attendee = attendeeSummary(found.user, found.application);
    const alreadyMessage = attendee.name + " has already been served " + meal.name + ".";

    const existing = await MealCheckIn.findOne({ user: found.user._id, mealService: meal._id }).populate(
      "checkedInBy",
      "name"
    );
    if (existing) {
      return sendAlreadyCheckedIn(res, attendee, existing, alreadyMessage);
    }

    let checkIn;
    try {
      checkIn = await MealCheckIn.create({
        user: found.user._id,
        mealService: meal._id,
        checkedInBy: req.user.id,
      });
    } catch (err) {
      // Two scans of the same code at once: the unique index let only one in.
      if (err && err.code === 11000) {
        const winner = await MealCheckIn.findOne({ user: found.user._id, mealService: meal._id }).populate(
          "checkedInBy",
          "name"
        );
        return sendAlreadyCheckedIn(res, attendee, winner, alreadyMessage);
      }
      throw err;
    }

    // Not a blocker (the event check-in desk may be backed up), but staff
    // should know so they can send the attendee over.
    const eventCheckedIn = Boolean(await CheckIn.exists({ user: found.user._id }));

    return res.status(201).json({
      success: true,
      attendee: Object.assign(attendee, { eventCheckedIn: eventCheckedIn }),
      checkIn: checkIn,
    });
  } catch (err) {
    console.error("mealCheckInMark failed:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

module.exports = {
  searchAttendees: searchAttendees,
  checkInMark: checkInMark,
  getCheckInStatus: getCheckInStatus,
  listMealsForStaff: listMealsForStaff,
  mealCheckInMark: mealCheckInMark,
};
