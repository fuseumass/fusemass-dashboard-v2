"use strict";
var crypto = require("crypto");
var mongoose = require("mongoose");
var Workshop = require("../schemas/workshop");
var Attendance = require("../schemas/workshopAttendance");
var Attempt = require("../schemas/workshopAttempt");
var Draw = require("../schemas/raffleDraw");
var Signup = require("../schemas/workshopSignup");
var User = require("../schemas/user");
var Application = require("../schemas/application");
var Settings = require("../schemas/orgSettings");
var currentRole = require("../utils/currentRole").currentRole;
var resolveAttendee = require("./staffController").resolveAttendee;
var codeFor = require("../utils/workshopCode");
var csv = require("../utils/csv");
var mailer = require("../utils/mailer");

/** @param {object} req @param {object} res @param {function} next @returns {Promise<void>} */
async function manageable(req, res, next) {
  try {
    var role = await currentRole(req);
    if (!role)
      return res.status(401).json({ error: "Authentication required." });
    var query =
      ["admin", "moderator"].indexOf(role) !== -1
        ? {}
        : { organizers: req.user.id };
    res.json({
      workshops: await Workshop.find(
        Object.assign(query, { cancelled: false }),
      ).sort({ startsAt: 1 }),
    });
  } catch (err) {
    next(err);
  }
}
/** @param {object} req @param {object} res @param {function} next @returns {Promise<void>} */
async function session(req, res, next) {
  try {
    var action = req.path.split("/").pop();
    var minutes =
      req.body && req.body.minutes !== undefined
        ? Number(req.body.minutes)
        : 10;
    if (
      action !== "close" &&
      (!Number.isInteger(minutes) || minutes < 1 || minutes > 180)
    ) {
      return res
        .status(400)
        .json({ error: "Minutes must be a whole number from 1 to 180." });
    }
    var now = Date.now();
    var query = { _id: req.workshop._id };
    var update;
    if (action === "close")
      update = {
        $set: { attendanceOpenUntil: null },
        $unset: { attendanceSecret: 1 },
      };
    else if (action === "open") {
      query.$or = [
        { attendanceOpenUntil: null },
        { attendanceOpenUntil: { $lte: new Date(now) } },
      ];
      update = {
        $set: {
          attendanceOpenUntil: new Date(now + minutes * 60000),
          attendanceSecret: crypto.randomBytes(32).toString("hex"),
        },
      };
    } else {
      // Compare-and-swap prevents an extend from resurrecting a closed/reopened session.
      query.attendanceOpenUntil = req.workshop.attendanceOpenUntil;
      if (!(+req.workshop.attendanceOpenUntil > now))
        return res
          .status(409)
          .json({ error: "Attendance is closed. Open a new session." });
      update = {
        $set: {
          attendanceOpenUntil: new Date(
            +req.workshop.attendanceOpenUntil + minutes * 60000,
          ),
        },
      };
    }
    var workshop = await Workshop.findOneAndUpdate(query, update, {
      new: true,
    });
    if (!workshop)
      return res
        .status(409)
        .json({ error: "Attendance session changed. Refresh and try again." });
    res.json({ openUntil: workshop.attendanceOpenUntil });
  } catch (err) {
    next(err);
  }
}
/** @param {object} req @param {object} res @param {function} next @returns {Promise<void>} */
async function code(req, res, next) {
  try {
    var workshop = await Workshop.findById(req.params.id).select(
      "+attendanceSecret",
    );
    res.set("Cache-Control", "no-store");
    if (
      !workshop ||
      !workshop.attendanceSecret ||
      !(+workshop.attendanceOpenUntil > Date.now())
    )
      return res.status(409).json({ error: "Attendance is closed." });
    var period = workshop.attendancePeriodSec;
    var now = Date.now();
    res.json({
      code: codeFor(workshop, now),
      secondsLeft: period - (Math.floor(now / 1000) % period),
      openUntil: workshop.attendanceOpenUntil,
    });
  } catch (err) {
    next(err);
  }
}
/** @param {object} identity @param {string} method @param {string} addedBy @returns {Promise<boolean>} True if already recorded. */
async function record(identity, method, addedBy) {
  try {
    var result = await Attendance.updateOne(
      identity,
      {
        $setOnInsert: Object.assign({}, identity, {
          method: method,
          addedBy: addedBy,
          checkedInAt: new Date(),
        }),
      },
      { upsert: true },
    );
    return !result.upsertedCount;
  } catch (err) {
    if (err.code === 11000) return true;
    throw err;
  }
}
/** @param {object} req @param {object} res @param {function} next @returns {Promise<void>} */
async function attend(req, res, next) {
  try {
    var user = await User.findById(req.user.id).select("checkedIn").lean();
    if (!user || !user.checkedIn)
      return res
        .status(403)
        .json({ error: "Check in at the front desk first" });
    if (!mongoose.isValidObjectId(req.params.id))
      return res.status(404).json({ error: "Workshop not found." });
    var workshop = await Workshop.findOne({
      _id: req.params.id,
      published: true,
      cancelled: false,
    }).select("+attendanceSecret");
    if (!workshop)
      return res.status(404).json({ error: "Workshop not found." });
    var identity = { user: req.user.id, workshop: workshop._id };
    if (await Attendance.exists(identity))
      return res.json({ attended: true, alreadyHere: true });
    if (
      !workshop.attendanceSecret ||
      !(+workshop.attendanceOpenUntil > Date.now())
    )
      return res
        .status(409)
        .json({ error: "Attendance is closed. Ask the organizer to open it." });
    var key = {
      user: req.user.id,
      session: crypto
        .createHash("sha256")
        .update(workshop.attendanceSecret)
        .digest("hex"),
    };
    var attempt = await Attempt.findOne(key).lean();
    if (attempt && attempt.wrong >= 10)
      return res.status(429).json({
        error: "Too many wrong codes. Ask a staff member to add you.",
      });
    var value = String((req.body || {}).code || "")
      .trim()
      .toUpperCase();
    var now = Date.now();
    if (
      value !== codeFor(workshop, now) &&
      value !== codeFor(workshop, now - workshop.attendancePeriodSec * 1000)
    ) {
      try {
        attempt = await Attempt.findOneAndUpdate(
          key,
          { $inc: { wrong: 1 } },
          { upsert: true, new: true },
        );
      } catch (err) {
        if (err.code !== 11000) throw err;
        attempt = await Attempt.findOneAndUpdate(
          key,
          { $inc: { wrong: 1 } },
          { new: true },
        );
      }
      return res.status(attempt.wrong >= 10 ? 429 : 400).json({
        error:
          attempt.wrong >= 10
            ? "Too many wrong codes. Ask a staff member to add you."
            : "That code is wrong or has expired. Enter the current code on screen.",
      });
    }
    if (
      !(await Workshop.exists({
        _id: workshop._id,
        cancelled: false,
        attendanceSecret: workshop.attendanceSecret,
        attendanceOpenUntil: { $gt: new Date() },
      }))
    ) {
      return res.status(409).json({
        error:
          "Attendance is closed or the session changed. Ask the organizer for the current code.",
      });
    }
    var already = await record(identity, "code");
    res.json({ attended: true, alreadyHere: already });
  } catch (err) {
    next(err);
  }
}
/** @param {object} req @param {object} res @param {function} next @returns {Promise<void>} */
async function staff(req, res, next) {
  try {
    var found = await resolveAttendee(req.body || {});
    if (found.error)
      return res.status(found.status).json({ error: found.error });
    if (!found.user.checkedIn)
      return res
        .status(403)
        .json({ error: "Check in at the front desk first" });
    var already = await record(
      { user: found.user._id, workshop: req.workshop._id },
      "staff",
      req.user.id,
    );
    res.json({ attended: true, alreadyHere: already });
  } catch (err) {
    next(err);
  }
}
/** @param {object} req @param {object} res @param {function} next @returns {Promise<void>} */
async function attendance(req, res, next) {
  try {
    var signups = await Signup.find({ workshop: req.params.id }).distinct(
      "user",
    );
    var signed = new Set(signups.map(String));
    var query = Attendance.find({ workshop: req.params.id })
      .populate("user", "name email")
      .sort({ checkedInAt: 1 })
      .lean();
    if (req.path.endsWith(".csv")) {
      var cursor = query.cursor();
      try {
        await csv.sendCsv(res, {
          filename: csv.datedFilename("workshop-attendance", "csv"),
          header: ["Name", "Email", "Checked in at", "Method", "Walk-in"],
          nextRows: async function batch() {
            var batch = [];
            for (var i = 0; i < 100; i += 1) {
              var row = await cursor.next();
              if (!row) break;
              batch.push([
                row.user && row.user.name,
                row.user && row.user.email,
                row.checkedInAt,
                row.method,
                !row.user || !signed.has(String(row.user._id)),
              ]);
            }
            return batch;
          },
        });
      } finally {
        await cursor.close();
      }
      return;
    }
    var rows = await query;
    var counts = {
      signedUp: signups.length,
      attended: rows.length,
      walkIns: rows.filter(function walk(row) {
        return !row.user || !signed.has(String(row.user._id));
      }).length,
    };
    var settings = await Settings.getSingleton();
    res.json({
      workshop: req.workshop,
      attendees: rows,
      counts: counts,
      organizerRoom: settings.organizerRoom || "the organizer room",
    });
  } catch (err) {
    next(err);
  }
}
/** @param {object} req @param {object} res @param {function} next @returns {Promise<void>} */
async function me(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id))
      return res.status(404).json({ error: "Workshop not found." });
    var workshop = await Workshop.findOne({
      _id: req.params.id,
      published: true,
      cancelled: false,
    }).lean();
    if (!workshop)
      return res.status(404).json({ error: "Workshop not found." });
    delete workshop.organizers;
    var draws = await Draw.find({
      workshop: workshop._id,
      "winners.user": req.user.id,
    }).lean();
    var wins = [];
    draws.forEach(function draw(item) {
      item.winners.forEach(function winner(winner) {
        if (String(winner.user) === req.user.id && !winner.noShow)
          wins.push({ prize: item.prize, claimed: winner.claimed });
      });
    });
    var settings = await Settings.getSingleton();
    var user = await User.findById(req.user.id).select("checkedIn").lean();
    res.json({
      workshop: workshop,
      attendanceOpen: +workshop.attendanceOpenUntil > Date.now(),
      attended: Boolean(
        await Attendance.exists({ workshop: workshop._id, user: req.user.id }),
      ),
      checkedIn: Boolean(user && user.checkedIn),
      wins: wins,
      organizerRoom: settings.organizerRoom || "the organizer room",
    });
  } catch (err) {
    next(err);
  }
}
/** @param {object} workshop @param {object} draw @returns {Promise<void>} */
async function emailWinners(workshop, draw) {
  var settings = await Settings.getSingleton();
  var users = await User.find({
    _id: {
      $in: draw.winners.map(function id(w) {
        return w.user;
      }),
    },
  })
    .select("name email")
    .lean();
  await Promise.all(
    users.map(function send(user) {
      return mailer.sendTemplateEmail(user.email, "raffle_winner", {
        name: user.name,
        title: workshop.title,
        prize: draw.prize,
        organizerRoom: settings.organizerRoom || "the organizer room",
      });
    }),
  );
}
/**
 * The unique workshop/winner index atomically commits the audit and winners.
 * Losing concurrent draws recompute the pool, including across server processes.
 * @param {object} workshop @param {string} drawnBy @param {number} count @param {string} prize @param {object} redrawOf @returns {Promise<object|null>}
 */
async function pick(workshop, drawnBy, count, prize, redrawOf) {
  await Draw.init();
  for (;;) {
    var previous = await Draw.find({ workshop: workshop._id }).distinct(
      "winners.user",
    );
    var excluded = previous;
    var attendees = await Attendance.find({ workshop: workshop._id }).distinct(
      "user",
    );
    var accepted = await Application.find({
      applicant: { $in: attendees },
      status: "accepted",
    }).distinct("applicant");
    var pool = await User.find({
      _id: { $in: accepted, $nin: excluded },
      checkedIn: true,
    }).distinct("_id");
    if (!pool.length) return null;
    var poolSize = pool.length;
    for (var i = pool.length - 1; i > 0; i -= 1) {
      var j = crypto.randomInt(i + 1);
      var swap = pool[i];
      pool[i] = pool[j];
      pool[j] = swap;
    }
    var ids = pool.slice(0, count);
    if (
      !(await Workshop.exists({
        _id: workshop._id,
        cancelled: false,
        raffleEnabled: true,
      }))
    )
      return null;
    var draw;
    try {
      draw = await Draw.create({
        workshop: workshop._id,
        drawnBy: drawnBy,
        prize: prize,
        count: ids.length,
        poolSize: poolSize,
        winners: ids.map(function winner(id) {
          return { user: id };
        }),
        redrawOf: redrawOf || null,
      });
    } catch (err) {
      if (err.code === 11000) continue;
      throw err;
    }
    emailWinners(workshop, draw).catch(function failed(err) {
      console.error("Raffle email failed:", err.message);
    });
    return draw;
  }
}
/** @param {object} req @param {object} res @param {function} next @returns {Promise<void>} */
async function draw(req, res, next) {
  try {
    var body = req.body || {};
    var count = Number(body.count);
    if (
      !Number.isSafeInteger(count) ||
      count < 1 ||
      typeof body.prize !== "string" ||
      !body.prize.trim() ||
      body.prize.trim().length > 200 ||
      (body.early !== undefined && typeof body.early !== "boolean")
    )
      return res.status(400).json({
        error:
          "Enter a prize (up to 200 characters) and a positive whole number of winners.",
      });
    if (!req.workshop.raffleEnabled)
      return res
        .status(409)
        .json({ error: "Raffle is disabled for this workshop." });
    if (+req.workshop.endsAt > Date.now() && body.early !== true)
      return res.status(409).json({
        error: "The workshop has not ended. Choose End early to draw now.",
      });
    var result = await pick(
      req.workshop,
      req.user.id,
      count,
      body.prize.trim(),
    );
    if (!result)
      return res.status(409).json({ error: "No eligible attendees remain." });
    res.status(201).json({ draw: result });
  } catch (err) {
    next(err);
  }
}
/** @param {object} req @param {object} res @param {function} next @returns {Promise<void>} */
async function winner(req, res, next) {
  try {
    if (
      !mongoose.isValidObjectId(req.params.drawId) ||
      !mongoose.isValidObjectId(req.params.userId)
    )
      return res.status(404).json({ error: "Winner not found." });
    var redraw = req.path.endsWith("/redraw");
    if (redraw && !req.workshop.raffleEnabled)
      return res
        .status(409)
        .json({ error: "Raffle is disabled for this workshop." });
    var filter = {
      _id: req.params.drawId,
      workshop: req.params.id,
      winners: {
        $elemMatch: { user: req.params.userId, noShow: false, claimed: false },
      },
    };
    var update = redraw
      ? { "winners.$.noShow": true }
      : { "winners.$.claimed": true, "winners.$.claimedAt": new Date() };
    var original = await Draw.findOneAndUpdate(
      filter,
      { $set: update },
      { new: true },
    );
    if (!original)
      return res
        .status(409)
        .json({ error: "Winner already claimed or marked as a no-show." });
    if (!redraw) return res.json({ draw: original });
    var result = await pick(
      req.workshop,
      req.user.id,
      1,
      original.prize,
      original._id,
    );
    if (!result)
      return res
        .status(409)
        .json({ error: "No-show recorded. No eligible replacement remains." });
    res.status(201).json({ draw: result });
  } catch (err) {
    next(err);
  }
}
/** @param {object} req @param {object} res @param {function} next @returns {Promise<void>} */
async function history(req, res, next) {
  try {
    res.json({
      draws: await Draw.find(req.params.id ? { workshop: req.params.id } : {})
        .populate("winners.user", "name email")
        .populate("drawnBy", "name email")
        .populate("workshop", "title")
        .sort({ createdAt: -1 }),
    });
  } catch (err) {
    next(err);
  }
}
module.exports = {
  manageable: manageable,
  session: session,
  code: code,
  attend: attend,
  staff: staff,
  attendance: attendance,
  me: me,
  draw: draw,
  winner: winner,
  history: history,
};
