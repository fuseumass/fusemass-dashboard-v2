"use strict";

const mongoose = require("mongoose");

const User = require("../schemas/user");
const Application = require("../schemas/application");
const CheckIn = require("../schemas/checkin");
const MealService = require("../schemas/mealService");
const MealCheckIn = require("../schemas/mealCheckin");
const ScheduleEvent = require("../schemas/scheduleEvent");
const qrCode = require("../utils/qrCode");
const calendar = require("../utils/calendar");
const mailer = require("../utils/mailer");
const OrgSettings = require("../schemas/orgSettings");
const ApplicationRound = require("../schemas/applicationRound");
const checkInPopup = require("../utils/checkInPopup");
const passwordToken = require("../utils/passwordToken");

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
 * Find the user a check-in request refers to, by QR code or user id. A QR
 * that matches nobody triggers one rebuild of missing codes (they're SHA-256
 * of the email, so always recomputable) before giving up.
 * @param {object} body - Request body with `qrId` or `userId`.
 * @returns {Promise<object>} `{ user }`, or `{ status, error }`.
 */
async function findUser(body) {
  const rawQrId = body && body.qrId;
  const userId = body && body.userId;
  let user = null;

  if (rawQrId) {
    const qrId = qrCode.normalizeQrId(rawQrId);
    if (!qrId) {
      return { status: 400, error: "That is not a valid check-in QR code." };
    }
    user = await User.findOne({ qrId: qrId });
    if (!user && (await User.backfillQrIds()) > 0) {
      user = await User.findOne({ qrId: qrId });
    }
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

  return { user: user };
}

/**
 * Find the accepted attendee a check-in request refers to.
 * @param {object} body - Request body with `qrId` or `userId`.
 * @param {object} [options]
 * @param {boolean} [options.allowNotAccepted] - Forced check-in: also accept
 *   people whose application isn't accepted (or who never applied).
 * @param {boolean} [options.allowCheckedIn] - Also accept anyone already
 *   checked in to the event (so force-checked-in people can eat).
 * @returns {Promise<object>} `{ user, application, applicationStatus }` on
 *   success, or `{ status, error, code?, attendee? }` describing why not.
 */
async function resolveAttendee(body, options) {
  const opts = options || {};
  const found = await findUser(body);
  if (found.error) {
    return found;
  }
  const user = found.user;

  const accepted = await Application.findOne({ applicant: user._id, status: "accepted" });
  if (accepted) {
    return { user: user, application: accepted, applicationStatus: "accepted" };
  }

  const latest = await Application.findOne({ applicant: user._id }).sort({ updatedAt: -1 });
  const applicationStatus = latest ? latest.status : "none";

  if (opts.allowNotAccepted || (opts.allowCheckedIn && user.checkedIn)) {
    return { user: user, application: latest, applicationStatus: applicationStatus };
  }

  return {
    status: 400,
    code: "not_accepted",
    error: latest
      ? user.name + "'s application is " + applicationStatus + ", not accepted."
      : user.name + " hasn't applied.",
    attendee: Object.assign(attendeeSummary(user, latest), { applicationStatus: applicationStatus }),
  };
}

/**
 * Answer a resolveAttendee failure, passing along the attendee and reason
 * code when there is one (the check-in screen offers a forced check-in for
 * `not_accepted`).
 * @param {object} res - Express response.
 * @param {object} found - Failed resolveAttendee result.
 * @returns {void}
 */
function sendResolveError(res, found) {
  const body = { error: found.error };
  if (found.code) body.code = found.code;
  if (found.attendee) body.attendee = found.attendee;
  res.status(found.status).json(body);
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

/**
 * Email a just-arrived attendee the "checked_in" template: Discord + website
 * links and the run of show, which is also attached as a calendar invite.
 * Fire-and-forget: a mail failure is logged, never surfaced to the scanner.
 * @param {object} user - The attendee's User document.
 * @param {string} name - Name to greet them by.
 * @returns {Promise<void>}
 */
function sendCheckedInEmail(user, name) {
  return ScheduleEvent.find({})
    .then(function afterFind(events) {
      const options = {};
      if (events.length) {
        options.icalEvent = {
          filename: "run-of-show.ics",
          method: "PUBLISH",
          content: calendar.buildRunOfShowIcs(events, {
            orgName: process.env.ORG_NAME || "the hackathon",
            websiteUrl: process.env.ORG_WEBSITE_URL || "",
          }),
        };
      }
      return mailer.sendTemplateEmail(
        user.email,
        "checked_in",
        { name: name, runOfShow: calendar.formatRunOfShow(events) },
        options
      );
    })
    .catch(function onMailError(err) {
      console.error("Failed to send checked-in email:", err);
    });
}

/**
 * Make sure the user's checkedIn flag matches an existing check-in record
 * (repairs it if the flag write ever failed after the record was created).
 * @param {object} user - User document.
 * @param {object} record - Their CheckIn record.
 * @returns {Promise<void>}
 */
async function syncCheckedInFlag(user, record) {
  if (!user.checkedIn && record) {
    await User.updateOne({ _id: user._id }, { $set: { checkedIn: true, checkedInAt: record.checkedInAt } });
  }
}

//  GET /api/staff/checkin/stats
/**
 * How many accepted attendees there are and how many have checked in, for
 * the check-in screen's counter.
 * @param {object} _req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
async function checkInStats(_req, res) {
  try {
    const accepted = await Application.distinct("applicant", { status: "accepted" });
    const checkedIn = await User.countDocuments({ _id: { $in: accepted }, checkedIn: true });
    const forced = await CheckIn.countDocuments({ forced: true });
    return res.json({ accepted: accepted.length, checkedIn: checkedIn, forced: forced });
  } catch (err) {
    console.error("checkInStats failed:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

//  GET /api/staff/attendees?q=&all=1
/**
 * Search accepted attendees by name or email (the fallback for anyone without
 * their QR code). Returns up to 25, each with their check-in status. With
 * `all=1` (forced check-in), search every applicant account whatever its
 * application status, and include that status.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
async function searchAttendees(req, res) {
  try {
    const q = req.query && req.query.q ? String(req.query.q).trim() : "";
    const all = req.query && (req.query.all === "1" || req.query.all === "true");

    const applications = await Application.find(all ? {} : { status: "accepted" })
      .select("applicant name status updatedAt")
      .sort({ updatedAt: 1 })
      .lean();
    const nameByUser = {};
    const statusByUser = {};
    applications.forEach(function addApplicant(application) {
      const id = String(application.applicant);
      nameByUser[id] = application.name || nameByUser[id];
      // An accepted application wins; otherwise the most recent one.
      if (statusByUser[id] !== "accepted") statusByUser[id] = application.status;
    });

    const userFilter = all ? { role: "applicant" } : { _id: { $in: Object.keys(nameByUser) } };
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
          applicationStatus: statusByUser[String(user._id)] || "none",
          checkedIn: Boolean(checkIn),
          forced: Boolean(checkIn && checkIn.forced),
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
 * Mark an accepted attendee as checked in to the event (once per attendee):
 * records who/when in CheckIn, sets the user's checkedIn flag, and emails them
 * the "checked_in" template.
 * Body: { qrId } from a scan, or { userId } from the search.
 * Forced check-in: { ..., force: true, reason } also checks in someone whose
 * application isn't accepted; the reason is required and stored.
 * @param {object} req - Express request (req.user set by parseToken).
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
async function checkInMark(req, res) {
  try {
    const force = req.body && req.body.force === true;
    const reason = req.body && req.body.reason ? String(req.body.reason).trim() : "";
    if (force && reason.length < 3) {
      return res.status(400).json({ error: "A forced check-in needs a reason." });
    }

    const found = await resolveAttendee(req.body, { allowNotAccepted: force });
    if (found.error) {
      return sendResolveError(res, found);
    }
    // Forcing someone who is accepted anyway is just a normal check-in.
    const forced = force && found.applicationStatus !== "accepted";

    const attendee = attendeeSummary(found.user, found.application);
    const alreadyMessage = attendee.name + " is already checked in.";

    const existing = await CheckIn.findOne({ user: found.user._id }).populate("checkedInBy", "name");
    if (existing) {
      await syncCheckedInFlag(found.user, existing);
      return sendAlreadyCheckedIn(res, attendee, existing, alreadyMessage);
    }

    // The unique index on CheckIn.user is the guard: of two simultaneous
    // scans only one create succeeds, so only that request sets the flag and
    // sends the email.
    let checkIn;
    try {
      checkIn = await CheckIn.create({
        user: found.user._id,
        checkedInBy: req.user.id,
        forced: forced,
        forcedReason: forced ? reason : "",
        applicationStatus: found.applicationStatus,
      });
    } catch (err) {
      if (err && err.code === 11000) {
        const winner = await CheckIn.findOne({ user: found.user._id }).populate("checkedInBy", "name");
        return sendAlreadyCheckedIn(res, attendee, winner, alreadyMessage);
      }
      throw err;
    }

    await User.updateOne(
      { _id: found.user._id },
      { $set: { checkedIn: true, checkedInAt: checkIn.checkedInAt } }
    );

    const settings = await OrgSettings.getSingleton();
    // Custom questions on the popup are labelled from the round's form.
    const wantsAnswers = (settings.checkInPopupFields || []).some(checkInPopup.isAnswerField);
    const round =
      wantsAnswers && found.application && found.application.round
        ? await ApplicationRound.findById(found.application.round).select("formConfig").lean()
        : null;
    res.status(201).json({
      success: true,
      forced: forced,
      attendee: attendee,
      checkIn: checkIn,
      // Facts staff see in large type (null when the popup is switched off).
      popup: checkInPopup.buildPopup(settings, found.user, found.application, round && round.formConfig),
    });
    sendCheckedInEmail(found.user, attendee.name);
    return undefined;
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

    // Accepted attendees, plus anyone force-checked-in to the event.
    const found = await resolveAttendee(req.body, { allowCheckedIn: true });
    if (found.error) {
      return sendResolveError(res, found);
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

// ---- Attendee help (moderators + admins) ---------------------------------------
// Look someone up by email, resend their QR code email or an account link.
// Forcing a check-in for them uses POST /api/staff/checkin with force: true.

/**
 * What the Attendee help tab shows about one person.
 * @param {object} user - User document.
 * @param {object} [application] - Their accepted (or else latest) application.
 * @returns {object}
 */
function attendeeDetails(user, application) {
  return Object.assign(attendeeSummary(user, application), {
    applicationStatus: application ? application.status : "none",
    checkedIn: Boolean(user.checkedIn),
    checkedInAt: user.checkedInAt || null,
    // False for people who applied without an account and haven't set a password.
    accountReady: !passwordToken.needsPasswordSetup(user),
  });
}

/**
 * Find a user and their accepted (or latest) application by email.
 * @param {*} rawEmail - Email from the request.
 * @returns {Promise<{user: object, application: object|null}|null>}
 */
async function findByEmail(rawEmail) {
  const email = String(rawEmail || "").trim().toLowerCase();
  if (!email) return null;
  const user = await User.findOne({ email: email });
  if (!user) return null;
  const accepted = await Application.findOne({ applicant: user._id, status: "accepted" });
  const application = accepted || (await Application.findOne({ applicant: user._id }).sort({ updatedAt: -1 }));
  return { user: user, application: application };
}

const NOT_FOUND = { error: "No one with that email has applied or signed up." };

//   GET /api/staff/attendee?email=
/**
 * Look one person up by email for the Attendee help tab.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
async function lookupAttendee(req, res) {
  try {
    if (!req.query || !String(req.query.email || "").trim()) {
      return res.status(400).json({ error: "Enter an email address." });
    }
    const found = await findByEmail(req.query.email);
    if (!found) return res.status(404).json(NOT_FOUND);
    return res.status(200).json({ attendee: attendeeDetails(found.user, found.application) });
  } catch (err) {
    console.error("lookupAttendee failed:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

//   POST /api/staff/attendee/resend-qr   Body: { email }
/**
 * Send an accepted attendee their acceptance email again, with their
 * check-in QR code. Waits for the send, so staff see a real failure.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
async function resendQrEmail(req, res) {
  try {
    const found = await findByEmail(req.body && req.body.email);
    if (!found) return res.status(404).json(NOT_FOUND);
    if (!found.application || found.application.status !== "accepted") {
      return res.status(400).json({
        error: "Only accepted applicants have a check-in QR code.",
        attendee: attendeeDetails(found.user, found.application),
      });
    }
    if (!mailer.isMailConfigured()) {
      return res.status(503).json({ error: "Email isn't configured on the server." });
    }
    // retry: false because the failure is reported to the staff member right
    // here; a silent background retry as well could send it twice.
    await mailer.sendTemplateEmail(
      found.user.email,
      "application_accepted",
      {
        name: found.application.name || found.user.name,
        status: "accepted",
      },
      { retry: false, userId: found.user._id, requestedBy: req.user.id }
    );
    console.log("[attendee help] " + req.user.email + " resent the QR code email to " + found.user.email);
    return res.status(200).json({ sent: true, attendee: attendeeDetails(found.user, found.application) });
  } catch (err) {
    console.error("resendQrEmail failed:", err);
    return res.status(500).json({ error: "Could not send the email." });
  }
}

//   POST /api/staff/attendee/send-account-link   Body: { email }
/**
 * Email someone a way into their account: the 7-day "set up your account"
 * link if they have no password yet (applied without an account), otherwise
 * a 1-hour password reset link. Either one replaces any earlier link.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
async function sendAccountLink(req, res) {
  try {
    const found = await findByEmail(req.body && req.body.email);
    if (!found) return res.status(404).json(NOT_FOUND);
    if (!mailer.isMailConfigured()) {
      return res.status(503).json({ error: "Email isn't configured on the server." });
    }
    const user = found.user;
    let kind;
    if (passwordToken.needsPasswordSetup(user)) {
      const rawToken = await passwordToken.issuePasswordToken(user, passwordToken.SETUP_TTL_MS);
      await mailer.sendTemplateEmail(
        user.email,
        "account_setup",
        {
          name: (found.application && found.application.name) || user.name,
          setupUrl: passwordToken.passwordLink(rawToken, { setup: true }),
        },
        { retry: false, userId: user._id, requestedBy: req.user.id }
      );
      kind = "setup";
    } else {
      const rawToken = await passwordToken.issuePasswordToken(user, passwordToken.RESET_TTL_MS);
      await mailer.sendPasswordReset(user.email, passwordToken.passwordLink(rawToken));
      kind = "reset";
    }
    console.log("[attendee help] " + req.user.email + " sent a " + kind + " link to " + user.email);
    return res.status(200).json({ sent: true, kind: kind, attendee: attendeeDetails(user, found.application) });
  } catch (err) {
    console.error("sendAccountLink failed:", err);
    return res.status(500).json({ error: "Could not send the email." });
  }
}

module.exports = {
  resolveAttendee: resolveAttendee,
  lookupAttendee: lookupAttendee,
  resendQrEmail: resendQrEmail,
  sendAccountLink: sendAccountLink,
  checkInStats: checkInStats,
  searchAttendees: searchAttendees,
  checkInMark: checkInMark,
  getCheckInStatus: getCheckInStatus,
  listMealsForStaff: listMealsForStaff,
  mealCheckInMark: mealCheckInMark,
};
