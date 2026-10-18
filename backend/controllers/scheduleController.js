"use strict";

var mongoose = require("mongoose");
var ScheduleEvent = require("../schemas/scheduleEvent");

// Admin CRUD for the run of show (mounted under /api/admin/schedule behind
// isAdmin). The list is emailed to attendees as a calendar invite when they
// check in.

var TEXT_FIELDS = ["title", "location", "description"];

/**
 * @param {*} value - A date string or Date from the request.
 * @returns {Date|null} The parsed date, or null when missing/invalid.
 */
function parseDate(value) {
  if (!value) {
    return null;
  }
  var parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Pick the editable fields out of a request body, trimming text.
 * @param {object} body - Request body.
 * @returns {object} Only the fields present in the body.
 */
function pickFields(body) {
  var fields = {};
  TEXT_FIELDS.forEach(function pickText(key) {
    if (body && body[key] !== undefined) {
      fields[key] = String(body[key] == null ? "" : body[key]).trim();
    }
  });
  return fields;
}

/**
 * @param {object} fields - Candidate { title, startsAt, endsAt }.
 * @returns {string} An error message, or "" when valid.
 */
function validateEvent(fields) {
  if (!fields.title) {
    return "title is required.";
  }
  if (!fields.startsAt || !fields.endsAt) {
    return "startsAt and endsAt must be valid date-time values.";
  }
  if (fields.startsAt.getTime() >= fields.endsAt.getTime()) {
    return "endsAt must be after startsAt.";
  }
  return "";
}

/**
 * GET /api/admin/schedule — the run of show, in order.
 * @param {object} _req
 * @param {object} res
 * @returns {Promise<void>}
 */
function listScheduleEvents(_req, res) {
  return ScheduleEvent.find({})
    .sort({ startsAt: 1, createdAt: 1 })
    .then(function afterFind(events) {
      res.status(200).json({ events: events });
    })
    .catch(function onError(err) {
      console.error("listScheduleEvents failed:", err);
      res.status(500).json({ error: "Could not load the run of show." });
    });
}

/**
 * POST /api/admin/schedule — add an item to the run of show.
 * Body: { title, startsAt, endsAt, location?, description? }
 * @param {object} req
 * @param {object} res
 * @returns {Promise<void>}
 */
function createScheduleEvent(req, res) {
  var fields = pickFields(req.body);
  fields.startsAt = parseDate(req.body && req.body.startsAt);
  fields.endsAt = parseDate(req.body && req.body.endsAt);

  var error = validateEvent(fields);
  if (error) {
    res.status(400).json({ error: error });
    return Promise.resolve();
  }

  return ScheduleEvent.create(fields)
    .then(function afterCreate(event) {
      res.status(201).json({ event: event });
    })
    .catch(function onError(err) {
      console.error("createScheduleEvent failed:", err);
      res.status(500).json({ error: "Could not add to the run of show." });
    });
}

/**
 * PATCH /api/admin/schedule/:id — edit a run-of-show item.
 * Body: any of { title, startsAt, endsAt, location, description }
 * @param {object} req
 * @param {object} res
 * @returns {Promise<void>}
 */
function updateScheduleEvent(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ error: "Run-of-show item not found." });
    return Promise.resolve();
  }

  var update = pickFields(req.body);
  if (req.body && req.body.startsAt !== undefined) {
    update.startsAt = parseDate(req.body.startsAt);
  }
  if (req.body && req.body.endsAt !== undefined) {
    update.endsAt = parseDate(req.body.endsAt);
  }

  return ScheduleEvent.findById(req.params.id)
    .then(function afterFind(existing) {
      if (!existing) {
        res.status(404).json({ error: "Run-of-show item not found." });
        return null;
      }

      // Validate the item as it will be after the edit.
      var error = validateEvent(Object.assign({}, existing.toObject(), update));
      if (error) {
        res.status(400).json({ error: error });
        return null;
      }

      existing.set(update);
      return existing.save().then(function afterSave(event) {
        res.status(200).json({ event: event });
      });
    })
    .catch(function onError(err) {
      console.error("updateScheduleEvent failed:", err);
      res.status(500).json({ error: "Could not update the run of show." });
    });
}

/**
 * DELETE /api/admin/schedule/:id — remove a run-of-show item.
 * @param {object} req
 * @param {object} res
 * @returns {Promise<void>}
 */
function deleteScheduleEvent(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ error: "Run-of-show item not found." });
    return Promise.resolve();
  }

  return ScheduleEvent.findByIdAndDelete(req.params.id)
    .then(function afterDelete(event) {
      if (!event) {
        res.status(404).json({ error: "Run-of-show item not found." });
        return;
      }
      res.status(200).json({ ok: true });
    })
    .catch(function onError(err) {
      console.error("deleteScheduleEvent failed:", err);
      res.status(500).json({ error: "Could not delete from the run of show." });
    });
}

module.exports = {
  listScheduleEvents: listScheduleEvents,
  createScheduleEvent: createScheduleEvent,
  updateScheduleEvent: updateScheduleEvent,
  deleteScheduleEvent: deleteScheduleEvent,
};
