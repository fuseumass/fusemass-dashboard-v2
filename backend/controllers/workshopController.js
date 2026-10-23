"use strict";
var mongoose = require("mongoose");
var Workshop = require("../schemas/workshop");
var Signup = require("../schemas/workshopSignup");
var Application = require("../schemas/application");
var User = require("../schemas/user");
var calendar = require("../utils/calendar");
var mailer = require("../utils/mailer");

/** @param {object} req @param {object} res @param {function} next @returns {Promise<void>} */
async function accepted(req, res, next) {
  try {
    if (
      !(await Application.exists({
        applicant: req.user.id,
        status: "accepted",
      }))
    ) {
      res
        .status(403)
        .json({ error: "Workshops are available to accepted applicants." });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** @param {object} body @param {object} existing @returns {object} Validated editable fields. */
function fields(body, existing) {
  var result = Object.assign({}, existing || {});
  ["title", "description", "host", "location"].forEach(function text(key) {
    if (body[key] !== undefined)
      result[key] = String(body[key] == null ? "" : body[key]).trim();
  });
  ["startsAt", "endsAt"].forEach(function date(key) {
    if (body[key] !== undefined)
      result[key] = body[key] ? new Date(body[key]) : null;
  });
  ["published", "raffleEnabled"].forEach(function boolean(key) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "boolean")
        throw new Error(key + " must be true or false.");
      result[key] = body[key];
    }
  });
  if (body.capacity !== undefined) result.capacity = Number(body.capacity);
  if (!result.title) throw new Error("Title is required.");
  if (
    !result.startsAt ||
    !result.endsAt ||
    !Number.isFinite(+result.startsAt) ||
    !Number.isFinite(+result.endsAt) ||
    +result.startsAt >= +result.endsAt
  ) {
    throw new Error("Enter valid times with the end after the start.");
  }
  if (
    result.capacity !== undefined &&
    (!Number.isSafeInteger(result.capacity) || result.capacity < 0)
  ) {
    throw new Error("Capacity must be a nonnegative whole number.");
  }
  return result;
}

/** @param {object} workshop @param {string} userId @param {string} key @param {string} method @returns {Promise<void>} */
async function email(workshop, userId, key, method) {
  var user = await User.findById(userId).select("email name").lean();
  if (!user) return;
  try {
    await mailer.sendTemplateEmail(
      user.email,
      key,
      {
        name: user.name,
        title: workshop.title,
        location: workshop.location,
        when: calendar.formatTimeRange(workshop.startsAt, workshop.endsAt),
        orgName: process.env.ORG_NAME || "Event",
      },
      {
        icalEvent: {
          method: method,
          filename: "workshop.ics",
          content: calendar.buildWorkshopIcs(workshop, method),
        },
      },
    );
  } catch (err) {
    // The mail outbox retains failed sends for retry; the saved signup stays valid.
    console.error("Workshop email failed:", err.message);
  }
}

/** @param {object} workshop @param {string} key @param {string} method @returns {Promise<void>} */
async function notify(workshop, key, method) {
  var signups = await Signup.find({ workshop: workshop._id }).lean();
  await Promise.all(
    signups.map(function send(signup) {
      return email(workshop, signup.user, key, method);
    }),
  );
}

/**
 * Start notify() without waiting for it; failures are logged (each send is
 * also in the email outbox).
 * @param {object} workshop @param {string} key @param {string} method
 * @returns {void}
 */
function notifyInBackground(workshop, key, method) {
  notify(workshop, key, method).catch(function onError(err) {
    console.error("Workshop notifications failed:", err.message);
  });
}

/** @param {object} req @param {object} res @param {function} next @returns {Promise<void>} */
async function listAdmin(req, res, next) {
  try {
    res.json({ workshops: await Workshop.find({}).sort({ startsAt: 1 }) });
  } catch (err) {
    next(err);
  }
}
/** @param {object} req @param {object} res @param {function} next @returns {Promise<void>} */
async function create(req, res, next) {
  var data;
  try {
    data = fields(req.body || {});
  } catch (err) {
    res.status(400).json({ error: err.message });
    return;
  }
  try {
    res.status(201).json({ workshop: await Workshop.create(data) });
  } catch (err) {
    next(err);
  }
}
/** @param {object} req @param {object} res @param {function} next @returns {Promise<void>} */
async function update(req, res, next) {
  try {
    var workshop =
      mongoose.isValidObjectId(req.params.id) &&
      (await Workshop.findById(req.params.id));
    if (!workshop) {
      res.status(404).json({ error: "Workshop not found." });
      return;
    }
    if (workshop.cancelled) {
      res.status(409).json({ error: "Cancelled workshops cannot be edited." });
      return;
    }
    var data;
    try {
      data = fields(req.body || {}, workshop.toObject());
    } catch (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    var changed =
      +data.startsAt !== +workshop.startsAt ||
      +data.endsAt !== +workshop.endsAt ||
      data.location !== workshop.location;
    // Never write a stale signupCount read before a concurrent signup.
    var editable = {};
    [
      "title",
      "description",
      "host",
      "location",
      "startsAt",
      "endsAt",
      "capacity",
      "published",
      "raffleEnabled",
    ].forEach(function pick(key) {
      editable[key] = data[key];
    });
    var query = { _id: workshop._id, cancelled: false };
    if (data.capacity) query.signupCount = { $lte: data.capacity };
    var mutation = { $set: editable };
    if (changed) mutation.$inc = { sequence: 1 };
    workshop = await Workshop.findOneAndUpdate(query, mutation, {
      new: true,
      runValidators: true,
    });
    if (!workshop) {
      res
        .status(409)
        .json({
          error:
            "Capacity cannot be below the current signup count, or the workshop was cancelled.",
        });
      return;
    }
    // Emails go out in the background (the mailer spaces sends a second
    // apart), so a workshop with many sign-ups doesn't hold the request open.
    if (changed) notifyInBackground(workshop, "workshop_changed", "PUBLISH");
    res.json({ workshop: workshop });
  } catch (err) {
    next(err);
  }
}
/** @param {object} req @param {object} res @param {function} next @returns {Promise<void>} */
async function remove(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      res.status(404).json({ error: "Workshop not found." });
      return;
    }
    // Closing signups atomically before inspecting the counter prevents a signup/delete race.
    var workshop = await Workshop.findOneAndUpdate(
      { _id: req.params.id, cancelled: false },
      { $set: { cancelled: true }, $inc: { sequence: 1 } },
      { new: true },
    );
    if (!workshop) {
      if (await Workshop.exists({ _id: req.params.id })) {
        res.json({ ok: true });
        return;
      }
      res.status(404).json({ error: "Workshop not found." });
      return;
    }
    if (workshop.signupCount)
      notifyInBackground(workshop, "workshop_cancelled", "CANCEL");
    else await Workshop.deleteOne({ _id: workshop._id, signupCount: 0 });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
/** @param {object} req @param {object} res @param {function} next @returns {Promise<void>} */
async function list(req, res, next) {
  try {
    var signups = await Signup.find({ user: req.user.id }).lean();
    var ids = signups.map(function id(signup) {
      return String(signup.workshop);
    });
    var query =
      req.path === "/mine"
        ? { _id: { $in: ids }, cancelled: false, published: true }
        : { published: true, cancelled: false };
    var workshops = await Workshop.find(query).sort({ startsAt: 1 }).lean();
    res.json({
      workshops: workshops.map(function decorate(workshop) {
        delete workshop.organizers;
        workshop.spotsLeft =
          workshop.capacity === 0
            ? null
            : Math.max(0, workshop.capacity - workshop.signupCount);
        workshop.signedUp = ids.indexOf(String(workshop._id)) !== -1;
        return workshop;
      }),
    });
  } catch (err) {
    next(err);
  }
}
/** @param {object} req @param {object} res @param {function} next @returns {Promise<void>} */
async function signup(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      res.status(404).json({ error: "Workshop not found." });
      return;
    }
    var identity = { user: req.user.id, workshop: req.params.id };
    var existing = await Signup.exists(identity);
    var workshop = await Workshop.findOne({
      _id: req.params.id,
      published: true,
      cancelled: false,
    });
    if (!workshop) {
      res.status(404).json({ error: "Workshop not found." });
      return;
    }
    if (existing) {
      res.json({ signedUp: true });
      return;
    }
    workshop = await Workshop.findOneAndUpdate(
      {
        _id: req.params.id,
        published: true,
        cancelled: false,
        $or: [
          { capacity: 0 },
          { $expr: { $lt: ["$signupCount", "$capacity"] } },
        ],
      },
      { $inc: { signupCount: 1, sequence: 1 } },
      { new: true },
    );
    if (!workshop) {
      if (await Signup.exists(identity)) {
        res.json({ signedUp: true });
        return;
      }
      res
        .status(409)
        .json({ error: "This workshop is full or no longer available." });
      return;
    }
    try {
      await Signup.create(identity);
    } catch (err) {
      await Workshop.updateOne(
        { _id: workshop._id },
        { $inc: { signupCount: -1 } },
      );
      if (err.code === 11000) {
        res.json({ signedUp: true });
        return;
      }
      throw err;
    }
    // An admin may have closed signups between reserving the seat and inserting it.
    var current = await Workshop.findById(workshop._id);
    if (!current || current.cancelled) {
      var removed = await Signup.findOneAndDelete(identity);
      if (removed)
        await Workshop.updateOne(
          { _id: workshop._id },
          { $inc: { signupCount: -1 } },
        );
      res.status(409).json({ error: "This workshop was cancelled." });
      return;
    }
    workshop = current;
    var others = await Signup.find({
      user: req.user.id,
      workshop: { $ne: workshop._id },
    }).distinct("workshop");
    var overlap = await Workshop.exists({
      _id: { $in: others },
      cancelled: false,
      startsAt: { $lt: workshop.endsAt },
      endsAt: { $gt: workshop.startsAt },
    });
    await email(workshop, req.user.id, "workshop_signup", "PUBLISH");
    res
      .status(201)
      .json({
        signedUp: true,
        warning: overlap
          ? "This overlaps another of your workshops."
          : undefined,
      });
  } catch (err) {
    next(err);
  }
}
/** @param {object} req @param {object} res @param {function} next @returns {Promise<void>} */
async function cancelSignup(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      res.status(404).json({ error: "Workshop not found." });
      return;
    }
    var removed = await Signup.findOneAndDelete({
      user: req.user.id,
      workshop: req.params.id,
    });
    if (removed) {
      var workshop = await Workshop.findOneAndUpdate(
        { _id: req.params.id, signupCount: { $gt: 0 } },
        { $inc: { signupCount: -1, sequence: 1 } },
        { new: true },
      );
      if (workshop)
        await email(workshop, req.user.id, "workshop_cancelled", "CANCEL");
    }
    res.json({ signedUp: false });
  } catch (err) {
    next(err);
  }
}
module.exports = {
  accepted: accepted,
  listAdmin: listAdmin,
  create: create,
  update: update,
  remove: remove,
  list: list,
  signup: signup,
  cancelSignup: cancelSignup,
};
