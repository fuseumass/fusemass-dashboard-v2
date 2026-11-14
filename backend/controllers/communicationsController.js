"use strict";

var mongoose = require("mongoose");
var Announcement = require("../schemas/announcement");
var CommunicationSettings = require("../schemas/communicationSettings");
var User = require("../schemas/user");
var communications = require("../utils/communications");
var discordAnnouncements = require("../utils/discordAnnouncements");
var outbox = require("../utils/outbox");

var MAX_SCHEDULE_AHEAD_MS = 60 * 24 * 60 * 60 * 1000;
// A second identical announcement from the same person this soon is a double click.
var DUPLICATE_MS = 30 * 1000;
var SEND_LEASE_MS = 10 * 60 * 1000;

/**
 * An announcement as the page shows it.
 * @param {object} doc - Announcement (lean, createdBy populated).
 * @param {object} counts - Email status counts by id.
 * @returns {object}
 */
function serialize(doc, counts) {
  var id = String(doc._id);
  return {
    id: id,
    title: doc.title,
    message: doc.message,
    discordMessage: doc.discordMessage || "",
    discordTitle: doc.discordTitle || "",
    url: doc.url,
    channels: doc.channels,
    audience: doc.audience,
    audienceLabel: doc.audienceLabel,
    mentionEveryone: doc.mentionEveryone,
    status: doc.status,
    scheduledFor: doc.scheduledFor || null,
    sentAt: doc.sentAt || null,
    createdAt: doc.createdAt,
    createdBy: doc.createdBy && doc.createdBy.name ? { name: doc.createdBy.name } : null,
    emailCounts: doc.emailCounts,
    emailStatus: counts[id] || { queued: 0, sent: 0, failed: 0, cancelled: 0 },
    discord: doc.discord || [],
    error: doc.error || "",
    resendOf: doc.resendOf ? String(doc.resendOf) : null,
  };
}

/**
 * Load announcements and their outbox counts for the API.
 * @param {object} filter - Mongo filter.
 * @param {object} options - `{ skip, limit }`.
 * @returns {Promise<Array<object>>}
 */
function loadSerialized(filter, options) {
  return Announcement.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .skip(options.skip || 0)
    .limit(options.limit || 20)
    .populate("createdBy", "name")
    .lean()
    .then(function withCounts(docs) {
      return communications.emailStatusCounts(docs).then(function done(counts) {
        return docs.map(function each(doc) {
          return serialize(doc, counts);
        });
      });
    });
}

/**
 * @param {*} value - Candidate link.
 * @returns {boolean} Empty or a real http(s) URL.
 */
function isLinkOk(value) {
  if (!value) {
    return true;
  }
  try {
    var parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch (_err) {
    return false;
  }
}

/**
 * Validate the message part of a compose request.
 *
 * Email has its own subject (`title`) and body (`message`); Discord has its
 * own text (`discordMessage`, with `@everyone`, `@here` and `@label`
 * mentions) and an optional embed title (`discordTitle`). A request without
 * `discordMessage` is the older shape: one title and message for both.
 * @param {object} body - Request body.
 * @param {object} channels - From communications.channelStatus().
 * @param {Array<object>} tags - Saved Discord mention tags.
 * @returns {{error: (string|undefined), field: (string|undefined), value: object}}
 */
function validateMessage(body, channels, tags) {
  var title = typeof body.title === "string" ? body.title.trim() : "";
  var message = typeof body.message === "string" ? body.message.trim() : "";
  var url = typeof body.url === "string" ? body.url.trim() : "";
  var picked = Array.isArray(body.channels) ? body.channels : [];
  var discordTitle = typeof body.discordTitle === "string" ? body.discordTitle.trim() : "";
  var discordMessage = typeof body.discordMessage === "string" ? body.discordMessage.trim() : "";

  if (
    !picked.length ||
    picked.some(function unknown(channel) {
      return Announcement.CHANNELS.indexOf(channel) === -1;
    })
  ) {
    return { error: "Pick at least one channel.", field: "channels" };
  }
  var unique = Array.from(new Set(picked));
  for (var i = 0; i < unique.length; i += 1) {
    if (!channels[unique[i]]) {
      return {
        error:
          unique[i] === "email"
            ? "Email isn't set up on the server, so it can't be used."
            : "That Discord channel isn't set up yet. An admin can add " +
              discordAnnouncements.CHANNEL_ENV[unique[i]] +
              " in Technical settings.",
        field: "channels",
      };
    }
  }
  var wantsEmail = unique.indexOf("email") !== -1;
  var wantsDiscord = unique.some(function isDiscord(channel) {
    return channel !== "email";
  });
  // Older requests send one title and message for both channels.
  var separate = body.discordMessage !== undefined && wantsDiscord;

  if (wantsEmail || !separate) {
    if (!title) {
      return { error: "Enter a subject.", field: "title" };
    }
    if (title.length > discordAnnouncements.MAX_TITLE) {
      return { error: "Keep the subject to " + discordAnnouncements.MAX_TITLE + " characters.", field: "title" };
    }
    if (!message) {
      return { error: "Write the email.", field: "message" };
    }
    if (message.length > discordAnnouncements.MAX_DESCRIPTION) {
      return { error: "Keep the email to " + discordAnnouncements.MAX_DESCRIPTION + " characters.", field: "message" };
    }
  }
  if (separate) {
    if (!discordMessage) {
      return { error: "Write the Discord message.", field: "discordMessage" };
    }
    if (discordTitle.length > discordAnnouncements.MAX_TITLE) {
      return { error: "Keep the Discord title to " + discordAnnouncements.MAX_TITLE + " characters.", field: "discordTitle" };
    }
    var resolved = discordAnnouncements.resolveMentions(discordMessage, tags);
    var limit = discordTitle ? discordAnnouncements.MAX_DESCRIPTION : discordAnnouncements.MAX_CONTENT;
    if (resolved.text.length + (discordTitle || !url || resolved.text.indexOf(url) !== -1 ? 0 : url.length + 1) > limit) {
      return {
        error:
          "Keep the Discord message to " +
          limit +
          " characters" +
          (discordTitle ? "." : " (add a title to allow " + discordAnnouncements.MAX_DESCRIPTION + ")."),
        field: "discordMessage",
      };
    }
  }
  if (!isLinkOk(url)) {
    return { error: "Enter a full link starting with https://, or leave it empty.", field: "url" };
  }
  if (body.mentionEveryone !== undefined && typeof body.mentionEveryone !== "boolean") {
    return { error: "mentionEveryone must be true or false.", field: "mentionEveryone" };
  }
  if (!wantsEmail && separate) {
    // Discord only: the email fields hold a copy so history has a title.
    title = discordTitle || discordAnnouncements.clip(discordMessage.split("\n")[0], 80);
    message = discordMessage;
  }
  return {
    value: {
      title: title,
      message: message,
      discordMessage: separate ? discordMessage : "",
      discordTitle: separate ? discordTitle : "",
      url: url,
      channels: unique,
      mentionEveryone: wantsDiscord && !separate && body.mentionEveryone === true,
    },
  };
}

/**
 * GET /api/staff/communications
 * Everything the page needs on load: which channels exist, the automation
 * settings, the audiences and what is coming up next.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function overview(req, res) {
  return Promise.all([
    communications.channelStatus(),
    CommunicationSettings.getSingleton(),
    communications.listAudiences(),
    communications.upcoming(),
    outbox.committedInLastDay(),
  ])
    .then(function withCounts(loaded) {
      // How many people each audience has and how many of them will get an
      // announcement email (accepted people unless they opted out, others
      // only if they opted in).
      return Promise.all(
        loaded[2].audiences.map(function count(audience) {
          if (audience.test || audience.key === "workshop") {
            return audience;
          }
          return communications
            .countAudience({ segment: audience.key }, { adminId: req.user.id })
            .then(function counted(found) {
              return Object.assign({}, audience, { inAudience: found.inAudience, recipients: found.recipients.length });
            });
        })
      ).then(function done(audiences) {
        loaded[2].audiences = audiences;
        return loaded;
      });
    })
    .then(function afterLoad(loaded) {
      res.status(200).json({
        channels: loaded[0],
        settings: communications.serializeSettings(loaded[1]),
        canEditSettings: req.user.role === "admin",
        audiences: loaded[2].audiences,
        workshops: loaded[2].workshops,
        next: loaded[3],
        dailyLimit: outbox.dailyLimit(),
        committedLast24h: loaded[4],
        webhookEnv: discordAnnouncements.CHANNEL_ENV,
      });
    })
    .catch(function onError(err) {
      console.error("communications overview failed:", err);
      res.status(500).json({ error: "Could not load the communications page." });
    });
}

/**
 * GET /api/staff/communications/announcements?page=&limit=
 * Announcement history, newest first.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function listAnnouncements(req, res) {
  var limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  var page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  return Promise.all([loadSerialized({}, { skip: (page - 1) * limit, limit: limit }), Announcement.countDocuments({})])
    .then(function afterLoad(loaded) {
      res.status(200).json({ announcements: loaded[0], total: loaded[1], page: page, limit: limit });
    })
    .catch(function onError(err) {
      console.error("listAnnouncements failed:", err);
      res.status(500).json({ error: "Could not load the announcement history." });
    });
}

/**
 * POST /api/staff/communications/preview
 * Body: { title, message, discordMessage?, discordTitle?, url?, channels, audience? }
 * The email and Discord post as they would go out, and who the email reaches.
 * Sends nothing.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function previewAnnouncement(req, res) {
  var body = req.body || {};
  var tags = [];
  return Promise.all([communications.channelStatus(), communications.loadTags()])
    .then(function afterChannels(loaded) {
      tags = loaded[1];
      var checked = validateMessage(body, loaded[0], tags);
      if (checked.error) {
        res.status(400).json({ error: checked.error, field: checked.field });
        return undefined;
      }
      var wantsEmail = checked.value.channels.indexOf("email") !== -1;
      var audienceStep = wantsEmail ? communications.validateAudience(body.audience) : Promise.resolve(null);
      return audienceStep.then(function afterAudience(audience) {
        if (audience && audience.error) {
          res.status(400).json({ error: audience.error, field: "audience" });
          return undefined;
        }
        return Promise.all([
          User.findById(req.user.id).select("name").lean(),
          audience ? communications.countAudience(audience.audience, { adminId: req.user.id }) : Promise.resolve(null),
        ]).then(function render(loaded) {
          var me = loaded[0];
          var counts = loaded[1];
          return communications.preview(checked.value, me && me.name, tags).then(function done(rendered) {
            res.status(200).json({
              email: wantsEmail ? rendered.email : null,
              discord: checked.value.channels.length > (wantsEmail ? 1 : 0) ? rendered.discord : null,
              pings: checked.value.channels.length > (wantsEmail ? 1 : 0) ? rendered.pings : [],
              audience: counts
                ? {
                    label: audience.label,
                    inAudience: counts.inAudience,
                    recipients: counts.recipients.length,
                    skippedOptOut: counts.skippedOptOut,
                  }
                : null,
            });
          });
        });
      });
    })
    .catch(function onError(err) {
      console.error("previewAnnouncement failed:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Could not build the preview." });
      }
    });
}

/**
 * Create and (now, or later) send an announcement.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @param {object} body - The compose fields.
 * @param {*} [resendOf] - Announcement this sends again.
 * @returns {Promise<void>}
 */
function createFrom(req, res, body, resendOf) {
  return Promise.all([communications.channelStatus(), communications.loadTags()])
    .then(function afterChannels(loaded) {
      var checked = validateMessage(body, loaded[0], loaded[1]);
      if (checked.error) {
        res.status(400).json({ error: checked.error, field: checked.field });
        return undefined;
      }
      var value = checked.value;
      var scheduledFor = null;
      if (body.scheduledFor !== undefined && body.scheduledFor !== null && body.scheduledFor !== "") {
        scheduledFor = new Date(body.scheduledFor);
        var ahead = scheduledFor.getTime() - Date.now();
        if (!Number.isFinite(scheduledFor.getTime()) || ahead < 0) {
          res.status(400).json({ error: "Pick a time in the future, or send it now.", field: "scheduledFor" });
          return undefined;
        }
        if (ahead > MAX_SCHEDULE_AHEAD_MS) {
          res.status(400).json({ error: "Schedule it at most 60 days ahead.", field: "scheduledFor" });
          return undefined;
        }
      }
      var wantsEmail = value.channels.indexOf("email") !== -1;
      var audienceStep = wantsEmail ? communications.validateAudience(body.audience) : Promise.resolve(null);
      return audienceStep.then(function afterAudience(audience) {
        if (audience && audience.error) {
          res.status(400).json({ error: audience.error, field: "audience" });
          return undefined;
        }
        return Announcement.exists({
          createdBy: req.user.id,
          title: value.title,
          message: value.message,
          status: { $ne: "cancelled" },
          createdAt: { $gte: new Date(Date.now() - DUPLICATE_MS) },
        }).then(function afterDuplicate(duplicate) {
          if (duplicate) {
            res.status(409).json({ error: "That announcement was just created. Check the history before sending it again.", code: "DUPLICATE" });
            return undefined;
          }
          var limitStep =
            wantsEmail && !scheduledFor
              ? Promise.all([
                  communications.countAudience(audience.audience, { adminId: req.user.id }),
                  outbox.committedInLastDay(),
                ])
              : Promise.resolve(null);
          return limitStep.then(function afterLimit(quota) {
            var limit = outbox.dailyLimit();
            if (quota && limit > 0 && quota[1] + quota[0].recipients.length > limit && body.allowOverLimit !== true) {
              res.status(409).json({
                error:
                  "This would pass the sending limit (" +
                  limit +
                  " emails per 24 hours): " +
                  quota[1] +
                  " already sent or waiting plus " +
                  quota[0].recipients.length +
                  " new. Send to fewer people, wait, or send anyway.",
                code: "OVER_DAILY_LIMIT",
              });
              return undefined;
            }
            var now = new Date();
            var doc = Object.assign({}, value, {
              audience: audience ? audience.audience : { segment: "" },
              audienceLabel: audience ? audience.label : "",
              createdBy: req.user.id,
              status: scheduledFor ? "scheduled" : "sending",
              scheduledFor: scheduledFor || undefined,
              sentAt: scheduledFor ? undefined : now,
              lockedUntil: scheduledFor ? undefined : new Date(now.getTime() + SEND_LEASE_MS),
              discord: [],
              resendOf: resendOf || undefined,
            });
            return Announcement.create(doc).then(function afterCreate(created) {
              var step = scheduledFor ? Promise.resolve(created) : communications.dispatch(created);
              return step.then(function respond(finished) {
                return loadSerialized({ _id: finished._id }, { limit: 1 }).then(function done(list) {
                  res.status(201).json({ announcement: list[0] });
                });
              });
            });
          });
        });
      });
    })
    .catch(function onError(err) {
      console.error("createAnnouncement failed:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Could not send the announcement." });
      }
    });
}

/**
 * POST /api/staff/communications/announcements
 * Body: { title, message, discordMessage?, discordTitle?, url?, channels, audience?, scheduledFor?, allowOverLimit? }
 * `title`/`message` are the email; `discordMessage` is the Discord text with @mentions.
 * Send now (the response has the result) or schedule for later.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function createAnnouncement(req, res) {
  return createFrom(req, res, req.body || {}, null);
}

/**
 * Load the announcement named by :id, or answer 404.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<object|null>}
 */
function loadAnnouncement(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ error: "Announcement not found." });
    return Promise.resolve(null);
  }
  return Announcement.findById(req.params.id).lean().then(function afterFind(doc) {
    if (!doc) {
      res.status(404).json({ error: "Announcement not found." });
    }
    return doc;
  });
}

/**
 * POST /api/staff/communications/announcements/:id/cancel
 * Cancel a scheduled announcement before it goes out.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function cancelAnnouncement(req, res) {
  return loadAnnouncement(req, res)
    .then(function afterLoad(doc) {
      if (!doc) {
        return undefined;
      }
      return Announcement.findOneAndUpdate(
        { _id: doc._id, status: "scheduled" },
        { $set: { status: "cancelled", cancelledBy: req.user.id } },
        { new: true }
      ).then(function afterCancel(cancelled) {
        if (!cancelled) {
          res.status(409).json({ error: "Only a scheduled announcement that hasn't gone out yet can be cancelled." });
          return undefined;
        }
        return loadSerialized({ _id: cancelled._id }, { limit: 1 }).then(function done(list) {
          res.status(200).json({ announcement: list[0] });
        });
      });
    })
    .catch(function onError(err) {
      console.error("cancelAnnouncement failed:", err);
      res.status(500).json({ error: "Could not cancel the announcement." });
    });
}

/**
 * POST /api/staff/communications/announcements/:id/send-again   Body: { allowOverLimit? }
 * Send a copy of an earlier announcement now, to the same channels and
 * audience (as the audience is today).
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function sendAgain(req, res) {
  return loadAnnouncement(req, res)
    .then(function afterLoad(doc) {
      if (!doc) {
        return undefined;
      }
      if (doc.status === "scheduled" || doc.status === "sending") {
        res.status(409).json({ error: "This announcement hasn't finished sending yet." });
        return undefined;
      }
      return createFrom(
        req,
        res,
        {
          title: doc.title,
          message: doc.message,
          discordMessage: doc.discordMessage || undefined,
          discordTitle: doc.discordTitle || undefined,
          url: doc.url,
          channels: doc.channels,
          audience: doc.audience && doc.audience.segment ? doc.audience : undefined,
          mentionEveryone: doc.mentionEveryone,
          allowOverLimit: req.body && req.body.allowOverLimit === true,
        },
        doc._id
      );
    })
    .catch(function onError(err) {
      console.error("sendAgain failed:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Could not send the announcement again." });
      }
    });
}

/**
 * PATCH /api/staff/communications/settings (admins)
 * Body: any of { reminderAll: { discord, email, offsets }, reminderSignedUp: { email, discord, offsets },
 * discordTags: [{ label, roleId }], workshopMention: { enabled, tag },
 * digestDiscord: { enabled, time, windowHours }, digestEmail: { enabled }, updatesDiscord: { enabled } }.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function updateSettings(req, res) {
  var checked = communications.validateSettings(req.body);
  if (checked.errors.length) {
    res.status(400).json({ error: checked.errors.join(" ") });
    return Promise.resolve();
  }
  checked.set.updatedBy = req.user.id;
  return CommunicationSettings.getSingleton()
    .then(function afterLoad() {
      return CommunicationSettings.findOneAndUpdate({ key: "default" }, { $set: checked.set }, { new: true, runValidators: true });
    })
    .then(function afterUpdate(settings) {
      return communications.upcoming().then(function done(next) {
        res.status(200).json({ settings: communications.serializeSettings(settings), next: next });
      });
    })
    .catch(function onError(err) {
      console.error("updateSettings failed:", err);
      res.status(500).json({ error: "Could not save the automation settings." });
    });
}

module.exports = {
  overview: overview,
  listAnnouncements: listAnnouncements,
  previewAnnouncement: previewAnnouncement,
  createAnnouncement: createAnnouncement,
  cancelAnnouncement: cancelAnnouncement,
  sendAgain: sendAgain,
  updateSettings: updateSettings,
};
