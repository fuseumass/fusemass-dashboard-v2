"use strict";

var mongoose = require("mongoose");
var Announcement = require("../schemas/announcement");
var AutomationLog = require("../schemas/automationLog");
var CommunicationSettings = require("../schemas/communicationSettings");
var EmailLog = require("../schemas/emailLog");
var EmailTemplate = require("../schemas/emailTemplate");
var User = require("../schemas/user");
var Workshop = require("../schemas/workshop");
var Signup = require("../schemas/workshopSignup");
var Application = require("../schemas/application");
var branding = require("./branding");
var calendar = require("./calendar");
var discordAnnouncements = require("./discordAnnouncements");
var emailSegments = require("./emailSegments");
var features = require("./features");
var mailer = require("./mailer");
var orgSettingsCache = require("./orgSettingsCache");
var outbox = require("./outbox");
var primaryClientOrigin = require("./clientOrigin").primaryClientOrigin;

/**
 * Announcements (email + Discord) and the workshop automations behind the
 * Communications page, plus the scheduler worker that runs them.
 *
 * Every automated send is claimed first by inserting an AutomationLog row
 * whose unique key names exactly what is being sent (see that schema), so the
 * worker can run in two processes, restart halfway, or tick twice in a
 * minute, and nobody gets the same reminder twice. Email always goes through
 * the outbox (pacing, daily limit, retries, preferences, the Outbox page).
 */

var MINUTE_MS = 60 * 1000;
var HOUR_MS = 60 * MINUTE_MS;
var DEFAULT_INTERVAL_MS = MINUTE_MS;
var SEND_LEASE_MS = 10 * MINUTE_MS;
// The daily digest goes out at its time, or up to this long after (a server
// restarted at 11 PM doesn't send the morning's list).
var DIGEST_GRACE_MS = 2 * HOUR_MS;
var NEXT_HORIZON_MS = 48 * HOUR_MS;

var timer = null;
var running = null;

// ---- Small helpers --------------------------------------------------------

/**
 * @param {Date} date - A moment.
 * @returns {object} Its wall-clock parts in the event time zone: { year, month, day, hour, minute }.
 */
function zonedParts(date) {
  var parts = new Intl.DateTimeFormat("en-US", {
    timeZone: calendar.eventTimeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  var out = {};
  parts.forEach(function each(part) {
    if (part.type !== "literal") {
      out[part.type] = Number(part.value);
    }
  });
  return out;
}

/**
 * The moment a wall-clock time in the event time zone happens.
 * @param {number} year - Year.
 * @param {number} month - Month, 1 to 12.
 * @param {number} day - Day of the month.
 * @param {number} hour - Hour, 0 to 23.
 * @param {number} minute - Minute.
 * @returns {Date}
 */
function zonedTime(year, month, day, hour, minute) {
  var wanted = Date.UTC(year, month - 1, day, hour, minute);
  var guess = wanted;
  // Two passes settle the offset, including across a DST change.
  for (var i = 0; i < 2; i += 1) {
    var p = zonedParts(new Date(guess));
    var shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += wanted - shown;
  }
  return new Date(guess);
}

/**
 * @param {Date} date - A moment.
 * @returns {string} Its date in the event time zone, YYYY-MM-DD.
 */
function zonedDateKey(date) {
  var p = zonedParts(date);
  return p.year + "-" + String(p.month).padStart(2, "0") + "-" + String(p.day).padStart(2, "0");
}

/**
 * "8:45 PM" in the event time zone.
 * @param {Date} date - A moment.
 * @returns {string}
 */
function formatClock(date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: calendar.eventTimeZone(),
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(date));
}

/**
 * "Sat 2:00 PM" in the event time zone.
 * @param {Date} date - A moment.
 * @returns {string}
 */
function formatDayClock(date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: calendar.eventTimeZone(),
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(date));
}

/**
 * @param {string} id - Workshop id.
 * @returns {string} The attendee page of one workshop.
 */
function workshopUrl(id) {
  return primaryClientOrigin() + "/dashboard/workshops/" + String(id);
}

/**
 * @returns {string} The attendee workshops list.
 */
function workshopsUrl() {
  return primaryClientOrigin() + "/dashboard/workshops";
}

/**
 * @param {object} workshop - Workshop document.
 * @returns {number|null} Spots left, or null when there is no limit.
 */
function spotsLeft(workshop) {
  return workshop.capacity ? Math.max(0, workshop.capacity - (workshop.signupCount || 0)) : null;
}

/**
 * The brand colour for Discord embeds.
 * @returns {Promise<string>} #RRGGBB.
 */
function brandColor() {
  return orgSettingsCache
    .get()
    .then(function afterSettings(settings) {
      return branding.resolve(settings).primaryColor;
    })
    .catch(function fallback() {
      return "";
    });
}

/**
 * Claim a key: resolves true for exactly one caller, ever.
 * @param {object} doc - AutomationLog fields (with `key`).
 * @returns {Promise<boolean>}
 */
function claim(doc) {
  return AutomationLog.create(doc).then(
    function claimed() {
      return true;
    },
    function onError(err) {
      if (err && err.code === 11000) {
        return false;
      }
      throw err;
    }
  );
}

/**
 * Record how a claimed automation went.
 * @param {string} key - The claim key.
 * @param {object} fields - { status, error, messageId }.
 * @returns {Promise<void>}
 */
function settle(key, fields) {
  return AutomationLog.updateOne({ key: key }, { $set: fields }).then(function done() {
    return undefined;
  });
}

// ---- Settings ---------------------------------------------------------------

var SETTING_RULES = {
  reminderEmail: { enabled: "boolean", minutesBefore: [5, 1440] },
  reminderDiscord: { enabled: "boolean", minutesBefore: [5, 1440] },
  digestDiscord: { enabled: "boolean", time: "time", windowHours: [1, 72] },
  digestEmail: { enabled: "boolean" },
  updatesDiscord: { enabled: "boolean" },
};

/**
 * Validate a settings PATCH (partial: only what is present changes).
 * @param {*} input - Request body.
 * @returns {{errors: Array<string>, set: object}}
 */
function validateSettings(input) {
  var errors = [];
  var set = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { errors: ["Send the settings as an object."], set: set };
  }
  Object.keys(input).forEach(function eachGroup(group) {
    var rules = SETTING_RULES[group];
    var value = input[group];
    if (!rules) {
      errors.push("Unknown setting \"" + group + "\".");
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(group + " must be an object.");
      return;
    }
    Object.keys(value).forEach(function eachField(field) {
      var rule = rules[field];
      var v = value[field];
      var path = group + "." + field;
      if (!rule) {
        errors.push("Unknown setting \"" + path + "\".");
      } else if (rule === "boolean") {
        if (typeof v !== "boolean") {
          errors.push(path + " must be true or false.");
        } else {
          set[path] = v;
        }
      } else if (rule === "time") {
        if (typeof v !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) {
          errors.push("Enter the digest time as HH:MM, for example 09:00.");
        } else {
          set[path] = v;
        }
      } else if (!Number.isInteger(v) || v < rule[0] || v > rule[1]) {
        errors.push(path + " must be a whole number from " + rule[0] + " to " + rule[1] + ".");
      } else {
        set[path] = v;
      }
    });
  });
  if (!errors.length && !Object.keys(set).length) {
    errors.push("Nothing to change.");
  }
  return { errors: errors, set: set };
}

/**
 * @param {object} settings - CommunicationSettings document.
 * @returns {object} Plain settings for the API.
 */
function serializeSettings(settings) {
  var s = settings.toObject ? settings.toObject() : settings;
  return {
    reminderEmail: s.reminderEmail,
    reminderDiscord: s.reminderDiscord,
    digestDiscord: s.digestDiscord,
    digestEmail: s.digestEmail,
    updatesDiscord: s.updatesDiscord,
    updatedAt: s.updatedAt,
  };
}

/**
 * Which channels exist right now.
 * @returns {Promise<object>} { email, discord_announcements, discord_workshops, workshops }.
 */
function channelStatus() {
  return orgSettingsCache.get().then(function afterSettings(settings) {
    return {
      email: mailer.isMailConfigured(),
      discord_announcements: discordAnnouncements.isConfigured("discord_announcements"),
      discord_workshops: discordAnnouncements.isConfigured("discord_workshops"),
      workshops: features.isEnabled(settings, "workshops"),
    };
  });
}

// ---- Audiences -------------------------------------------------------------

var EXTRA_AUDIENCES = [{ key: "workshop", label: "Signed up for a workshop", needsWorkshop: true }];
// Segments that are placeholders in the outbox list (this page has its own
// workshop audience) or that only mean something there.
var HIDDEN_SEGMENTS = ["workshop_signups", "hardware_holders"];

/**
 * The email audiences staff can pick.
 * @returns {Promise<{audiences: Array<object>, workshops: Array<object>}>}
 */
function listAudiences() {
  var segments = emailSegments
    .list()
    .filter(function usable(segment) {
      return segment.available && HIDDEN_SEGMENTS.indexOf(segment.key) === -1;
    })
    .map(function describe(segment) {
      return { key: segment.key, label: segment.label, test: segment.test };
    });
  return Workshop.find({ cancelled: false })
    .sort({ startsAt: 1 })
    .select("title startsAt endsAt published signupCount capacity location host")
    .lean()
    .then(function afterWorkshops(workshops) {
      return {
        audiences: segments.concat(EXTRA_AUDIENCES),
        workshops: workshops.map(function describe(workshop) {
          return {
            id: String(workshop._id),
            title: workshop.title,
            startsAt: workshop.startsAt,
            published: workshop.published,
            signupCount: workshop.signupCount,
          };
        }),
      };
    });
}

/**
 * Check an audience from a request.
 * @param {*} input - `{ segment, workshop?, checkedInOnly? }`.
 * @returns {Promise<{error: (string|undefined), audience: object, label: string}>}
 */
function validateAudience(input) {
  var value = input && typeof input === "object" ? input : {};
  var segmentKey = String(value.segment || "");
  var checkedInOnly = value.checkedInOnly === true;
  var suffix = checkedInOnly ? " (checked in only)" : "";
  if (segmentKey === "workshop") {
    if (!mongoose.isValidObjectId(value.workshop)) {
      return Promise.resolve({ error: "Pick the workshop whose sign-ups should get this." });
    }
    return Workshop.findById(value.workshop)
      .select("title cancelled")
      .lean()
      .then(function afterFind(workshop) {
        if (!workshop) {
          return { error: "That workshop doesn't exist any more." };
        }
        return {
          audience: { segment: "workshop", workshop: workshop._id, checkedInOnly: checkedInOnly },
          label: "Signed up for " + workshop.title + suffix,
        };
      });
  }
  var segment = emailSegments.find(segmentKey);
  if (!segment || segment.available === false || HIDDEN_SEGMENTS.indexOf(segment.key) !== -1) {
    return Promise.resolve({ error: "Pick who should get the email." });
  }
  return Promise.resolve({
    audience: { segment: segment.key, checkedInOnly: checkedInOnly },
    label: segment.label + suffix,
  });
}

/**
 * Everyone signed up for a workshop, as recipients.
 * @param {*} workshopId - Workshop _id.
 * @returns {Promise<Array<object>>} `{ userId, email, name, consent }`.
 */
function workshopRecipients(workshopId) {
  return Signup.find({ workshop: workshopId })
    .distinct("user")
    .then(function afterSignups(userIds) {
      return User.find({ _id: { $in: userIds } })
        .select("name email marketingEmailConsent emailPreferences checkedIn")
        .lean();
    })
    .then(function toRecipients(users) {
      return users.map(function each(user) {
        return {
          userId: user._id,
          email: String(user.email || "").toLowerCase(),
          name: user.name || "",
          consent: Boolean(user.marketingEmailConsent),
        };
      });
    });
}

/**
 * Who an audience is right now.
 * @param {object} audience - A validated audience.
 * @param {object} ctx - `{ adminId }` (for "test: just me").
 * @returns {Promise<Array<object>>} Recipients `{ userId, email, name, consent }`.
 */
function resolveAudience(audience, ctx) {
  var step =
    audience.segment === "workshop"
      ? workshopRecipients(audience.workshop)
      : emailSegments.resolve(emailSegments.find(audience.segment), { adminId: ctx && ctx.adminId });
  return step.then(function filterCheckedIn(recipients) {
    if (!audience.checkedInOnly) {
      return recipients;
    }
    return User.find({
      _id: {
        $in: recipients.map(function pick(r) {
          return r.userId;
        }),
      },
      checkedIn: true,
    })
      .distinct("_id")
      .then(function keep(ids) {
        var allowed = {};
        ids.forEach(function mark(id) {
          allowed[String(id)] = true;
        });
        return recipients.filter(function isIn(r) {
          return allowed[String(r.userId)];
        });
      });
  });
}

// ---- Announcements ---------------------------------------------------------

/**
 * The template values an announcement email is rendered from.
 * @param {object} announcement - `{ title, message, url }`.
 * @param {string} name - Recipient's name.
 * @returns {object}
 */
function emailValues(announcement, name) {
  return {
    name: name || "there",
    title: announcement.title,
    message: announcement.message,
    link: announcement.url || "",
  };
}

/**
 * Render the email and the Discord embed exactly as they will go out.
 * @param {object} announcement - `{ title, message, url, mentionEveryone }`.
 * @param {string} [name] - Name to greet in the email preview.
 * @returns {Promise<{email: object, discord: object}>}
 */
function preview(announcement, name) {
  return Promise.all([EmailTemplate.findOne({ key: "announcement" }).lean(), brandColor()]).then(function afterLoad(
    loaded
  ) {
    var template = loaded[0] || { subject: "{{title}}", body: "Hi {{name}},\n\n{{message}}\n\n{{link}}" };
    return mailer.renderEmail(template, emailValues(announcement, name)).then(function afterRender(rendered) {
      return {
        email: { subject: rendered.subject, text: rendered.text, html: rendered.html },
        discord: discordAnnouncements.buildPayload({
          title: announcement.title,
          description: announcement.message,
          url: announcement.url,
          color: loaded[1],
          mentionEveryone: announcement.mentionEveryone,
        }),
      };
    });
  });
}

/**
 * Who would get the email, before sending: the audience and how many have
 * announcements turned off.
 * @param {object} audience - Validated audience.
 * @param {object} ctx - `{ adminId }`.
 * @returns {Promise<{inAudience: number, recipients: Array<object>, skippedOptOut: number}>}
 */
function countAudience(audience, ctx) {
  return resolveAudience(audience, ctx).then(function count(recipients) {
    var test = audience.segment === "test_to_me";
    var eligible = test
      ? recipients
      : recipients.filter(function optedIn(r) {
          return r.consent === true;
        });
    return { inAudience: recipients.length, recipients: eligible, skippedOptOut: recipients.length - eligible.length };
  });
}

/**
 * Send a claimed announcement (status "sending") on every channel, and record
 * the outcome. Never rejects.
 * @param {object} announcement - Announcement document.
 * @returns {Promise<object>} The updated document.
 */
function dispatch(announcement) {
  var channels = announcement.channels || [];
  var result = { discord: [], emailCounts: announcement.emailCounts || {}, error: "" };
  var batchId = "announcement:" + String(announcement._id);

  var emailStep = Promise.resolve();
  if (channels.indexOf("email") !== -1) {
    if (!mailer.isMailConfigured()) {
      result.error = "Email isn't configured on the server, so no email was sent.";
    } else {
      emailStep = countAudience(announcement.audience, { adminId: announcement.createdBy }).then(function queue(found) {
        var test = announcement.audience.segment === "test_to_me";
        var entries = found.recipients.map(function toEntry(r) {
          return {
            to: r.email,
            user: r.userId,
            templateKey: "announcement",
            category: test ? "test" : "announcement",
            values: emailValues(announcement, r.name),
          };
        });
        return outbox
          .enqueueMany(entries, { batchId: batchId, segment: batchId, requestedBy: announcement.createdBy })
          .then(function afterQueue(queued) {
            result.emailCounts = { inAudience: found.inAudience, queued: queued, skippedOptOut: found.skippedOptOut };
          });
      });
    }
  }

  return emailStep
    .catch(function onEmailError(err) {
      console.error("Announcement email failed:", err);
      result.error = "Could not queue the emails.";
    })
    .then(function afterEmail() {
      var discordChannels = channels.filter(function isDiscord(channel) {
        return channel !== "email";
      });
      return brandColor().then(function afterColor(color) {
        return discordChannels.reduce(function chain(previous, channel) {
          return previous.then(function post() {
            return discordAnnouncements
              .send(channel, {
                title: announcement.title,
                description: announcement.message,
                url: announcement.url,
                color: color,
                mentionEveryone: announcement.mentionEveryone,
              })
              .then(function record(outcome) {
                result.discord.push(Object.assign({ channel: channel }, outcome));
              });
          });
        }, Promise.resolve());
      });
    })
    .then(function finish() {
      var anything =
        (result.emailCounts.queued || 0) > 0 ||
        result.discord.some(function ok(d) {
          return d.status === "sent";
        });
      var emailOnlyEmpty = channels.indexOf("email") !== -1 && !result.error && result.discord.length === 0;
      var status = anything || emailOnlyEmpty ? "sent" : "failed";
      if (status === "failed" && !result.error) {
        result.error = result.discord.length ? "Discord didn't accept the post." : "Nothing was sent.";
      }
      return Announcement.findByIdAndUpdate(
        announcement._id,
        {
          $set: {
            status: status,
            discord: result.discord,
            emailCounts: result.emailCounts,
            error: result.error,
            lockedUntil: null,
          },
        },
        { new: true }
      );
    })
    .catch(function onError(err) {
      console.error("Announcement dispatch failed:", err);
      return Announcement.findByIdAndUpdate(
        announcement._id,
        { $set: { status: "failed", error: "Sending stopped with an error.", lockedUntil: null } },
        { new: true }
      );
    });
}

/**
 * Claim an announcement for sending: atomic, so of two processes (or a
 * double click) exactly one gets it.
 * @param {object} filter - Extra conditions (e.g. due).
 * @returns {Promise<object|null>} The claimed document.
 */
function claimAnnouncement(filter) {
  var now = new Date();
  return Announcement.findOneAndUpdate(
    Object.assign({ status: "scheduled" }, filter),
    { $set: { status: "sending", sentAt: now, lockedUntil: new Date(now.getTime() + SEND_LEASE_MS) } },
    { new: true, sort: { scheduledFor: 1 } }
  );
}

/**
 * Send every scheduled announcement that is due, one after another.
 * @returns {Promise<number>} How many were sent.
 */
function sendDueAnnouncements() {
  var count = 0;
  function next() {
    return claimAnnouncement({ scheduledFor: { $lte: new Date() } }).then(function afterClaim(announcement) {
      if (!announcement) {
        return count;
      }
      count += 1;
      return dispatch(announcement).then(next);
    });
  }
  // One that was sending when the server stopped: we can't know what went
  // out, so it is marked failed instead of being sent twice.
  return Announcement.updateMany(
    { status: "sending", lockedUntil: { $lt: new Date() } },
    {
      $set: {
        status: "failed",
        lockedUntil: null,
        error: "Interrupted while sending (the server restarted). Check the outbox and Discord before sending it again.",
      },
    }
  ).then(next);
}

/**
 * Email counts per announcement, from the outbox.
 * @param {Array<object>} announcements - Announcement documents.
 * @returns {Promise<object>} id -> { queued, sent, failed, cancelled }.
 */
function emailStatusCounts(announcements) {
  var batchIds = announcements.map(function pick(a) {
    return "announcement:" + String(a._id);
  });
  if (!batchIds.length) {
    return Promise.resolve({});
  }
  return EmailLog.aggregate([
    { $match: { batchId: { $in: batchIds } } },
    { $group: { _id: { batch: "$batchId", status: "$status" }, n: { $sum: 1 } } },
  ]).then(function afterAggregate(rows) {
    var out = {};
    rows.forEach(function each(row) {
      var id = row._id.batch.replace(/^announcement:/, "");
      out[id] = out[id] || { queued: 0, sent: 0, failed: 0, cancelled: 0 };
      out[id][row._id.status] = row.n;
    });
    return out;
  });
}

// ---- Workshop automations ---------------------------------------------------

/**
 * Template values for one workshop email.
 * @param {object} workshop - Workshop document.
 * @param {string} name - Recipient's name.
 * @returns {object}
 */
function reminderValues(workshop, name) {
  return {
    name: name || "there",
    title: workshop.title,
    when: calendar.formatTimeRange(workshop.startsAt, workshop.endsAt),
    location: workshop.location || "See the dashboard",
    host: workshop.host || "The organizers",
    workshopUrl: workshopUrl(workshop._id),
  };
}

/**
 * The "starting soon" line for Discord.
 * @param {object} workshop - Workshop document.
 * @returns {string}
 */
function startingSoonText(workshop) {
  var text = "Starting soon: " + workshop.title + " at " + formatClock(workshop.startsAt);
  if (workshop.location) {
    text += " in " + workshop.location;
  }
  if (workshop.host) {
    text += ", hosted by " + workshop.host;
  }
  text += ".";
  var left = spotsLeft(workshop);
  if (left !== null) {
    text += " " + (left === 0 ? "It's full." : left + (left === 1 ? " spot left." : " spots left."));
  }
  return text + " Sign up on the dashboard: " + workshopUrl(workshop._id);
}

/**
 * Published, not cancelled workshops starting within a window.
 * @param {Date} from - Exclusive start.
 * @param {Date} to - Inclusive end.
 * @returns {Promise<Array<object>>}
 */
function workshopsStarting(from, to) {
  return Workshop.find({ published: true, cancelled: false, startsAt: { $gt: from, $lte: to } })
    .sort({ startsAt: 1 })
    .lean();
}

/**
 * @param {object} workshop - Workshop document.
 * @param {string} [userId] - Recipient, for email keys.
 * @param {string} kind - Automation kind.
 * @returns {string} The claim key (contains the start time, so a moved workshop gets new ones).
 */
function reminderKey(kind, workshop, userId) {
  return kind + ":" + String(workshop._id) + ":" + new Date(workshop.startsAt).toISOString() + (userId ? ":" + userId : "");
}

/**
 * Email everyone signed up for workshops starting within the reminder window
 * who hasn't had this reminder yet (late sign-ups included).
 * @param {object} settings - CommunicationSettings.
 * @param {Date} now - The current time.
 * @returns {Promise<number>} Emails queued.
 */
function runReminderEmails(settings, now) {
  if (!settings.reminderEmail.enabled || !mailer.isMailConfigured()) {
    return Promise.resolve(0);
  }
  var windowEnd = new Date(now.getTime() + settings.reminderEmail.minutesBefore * MINUTE_MS);
  var queued = 0;
  return workshopsStarting(now, windowEnd).then(function eachWorkshop(workshops) {
    return workshops.reduce(function chain(previous, workshop) {
      return previous.then(function remind() {
        return workshopRecipients(workshop._id).then(function claimEach(recipients) {
          var mine = [];
          return recipients
            .reduce(function claimOne(p, r) {
              return p.then(function tryClaim() {
                var key = reminderKey("workshop_reminder_email", workshop, String(r.userId));
                return claim({
                  key: key,
                  kind: "workshop_reminder_email",
                  workshop: workshop._id,
                  user: r.userId,
                  scheduledFor: new Date(new Date(workshop.startsAt).getTime() - settings.reminderEmail.minutesBefore * MINUTE_MS),
                }).then(function afterClaim(won) {
                  if (won) {
                    mine.push({ recipient: r, key: key });
                  }
                });
              });
            }, Promise.resolve())
            .then(function queueMine() {
              if (!mine.length) {
                return undefined;
              }
              var batchId = reminderKey("workshop_reminder", workshop);
              var entries = mine.map(function toEntry(item) {
                return {
                  to: item.recipient.email,
                  user: item.recipient.userId,
                  templateKey: "workshop_reminder",
                  category: "transactional",
                  values: reminderValues(workshop, item.recipient.name),
                };
              });
              return outbox.enqueueMany(entries, { batchId: batchId }).then(function afterQueue(count) {
                queued += count;
                return AutomationLog.updateMany(
                  {
                    key: {
                      $in: mine.map(function pick(item) {
                        return item.key;
                      }),
                    },
                  },
                  { $set: { status: "sent" } }
                );
              });
            });
        });
      });
    }, Promise.resolve()).then(function done() {
      return queued;
    });
  });
}

/**
 * Post "starting soon" for workshops entering the Discord reminder window.
 * @param {object} settings - CommunicationSettings.
 * @param {Date} now - The current time.
 * @returns {Promise<number>} Posts made.
 */
function runReminderDiscord(settings, now) {
  if (!settings.reminderDiscord.enabled || !discordAnnouncements.isConfigured("discord_workshops")) {
    return Promise.resolve(0);
  }
  var windowEnd = new Date(now.getTime() + settings.reminderDiscord.minutesBefore * MINUTE_MS);
  var posted = 0;
  return Promise.all([workshopsStarting(now, windowEnd), brandColor()]).then(function eachWorkshop(loaded) {
    return loaded[0].reduce(function chain(previous, workshop) {
      return previous.then(function post() {
        var key = reminderKey("workshop_reminder_discord", workshop);
        return claim({ key: key, kind: "workshop_reminder_discord", workshop: workshop._id }).then(function afterClaim(won) {
          if (!won) {
            return undefined;
          }
          return discordAnnouncements
            .send("discord_workshops", {
              title: "Starting soon: " + workshop.title,
              description: startingSoonText(workshop),
              url: workshopUrl(workshop._id),
              color: loaded[1],
            })
            .then(function record(outcome) {
              if (outcome.status === "sent") {
                posted += 1;
              }
              return settle(key, { status: outcome.status, error: outcome.error, messageId: outcome.messageId });
            });
        });
      });
    }, Promise.resolve()).then(function done() {
      return posted;
    });
  });
}

/**
 * When today's digest is due (or was), in the event time zone.
 * @param {object} settings - CommunicationSettings.
 * @param {Date} now - The current time.
 * @returns {{today: Date, dateKey: string}}
 */
function digestTimeToday(settings, now) {
  var p = zonedParts(now);
  var hm = String(settings.digestDiscord.time || "09:00").split(":");
  return { today: zonedTime(p.year, p.month, p.day, Number(hm[0]), Number(hm[1])), dateKey: zonedDateKey(now) };
}

/**
 * Workshops in the digest: published, starting within the window, with room.
 * @param {object} settings - CommunicationSettings.
 * @param {Date} now - The current time.
 * @returns {Promise<Array<object>>}
 */
function digestWorkshops(settings, now) {
  var end = new Date(now.getTime() + settings.digestDiscord.windowHours * HOUR_MS);
  return workshopsStarting(now, end).then(function withRoom(workshops) {
    return workshops.filter(function hasRoom(workshop) {
      return spotsLeft(workshop) !== 0;
    });
  });
}

/**
 * One line per workshop for the digest.
 * @param {Array<object>} workshops - Workshop documents.
 * @returns {string}
 */
function digestLines(workshops) {
  return workshops
    .map(function line(workshop) {
      var left = spotsLeft(workshop);
      return (
        "- " +
        workshop.title +
        ", " +
        formatDayClock(workshop.startsAt) +
        (workshop.location ? " in " + workshop.location : "") +
        (left === null ? "" : " (" + left + (left === 1 ? " spot left)" : " spots left)"))
      );
    })
    .join("\n");
}

/**
 * The daily sign-up digest: a post to the workshops channel and, when turned
 * on, an email to accepted participants who opted in to announcements. Each
 * goes out once per day, at the configured time (or within two hours of it).
 * @param {object} settings - CommunicationSettings.
 * @param {Date} now - The current time.
 * @returns {Promise<void>}
 */
function runDigest(settings, now) {
  var discordOn = settings.digestDiscord.enabled && discordAnnouncements.isConfigured("discord_workshops");
  var emailOn = settings.digestEmail.enabled && mailer.isMailConfigured();
  if (!discordOn && !emailOn) {
    return Promise.resolve();
  }
  var due = digestTimeToday(settings, now);
  var since = now.getTime() - due.today.getTime();
  if (since < 0 || since > DIGEST_GRACE_MS) {
    return Promise.resolve();
  }
  return digestWorkshops(settings, now).then(function send(workshops) {
    var steps = [];
    if (discordOn) {
      var key = "workshop_digest_discord:" + due.dateKey;
      steps.push(
        claim({ key: key, kind: "workshop_digest_discord", scheduledFor: due.today }).then(function afterClaim(won) {
          if (!won) {
            return undefined;
          }
          if (!workshops.length) {
            return settle(key, { status: "skipped", error: "No upcoming workshops with open spots." });
          }
          return brandColor().then(function post(color) {
            return discordAnnouncements
              .send("discord_workshops", {
                title: "Workshops coming up",
                description: digestLines(workshops) + "\n\nSign up on the dashboard: " + workshopsUrl(),
                url: workshopsUrl(),
                color: color,
              })
              .then(function record(outcome) {
                return settle(key, { status: outcome.status, error: outcome.error, messageId: outcome.messageId });
              });
          });
        })
      );
    }
    if (emailOn && workshops.length) {
      steps.push(sendDigestEmails(workshops, due));
    }
    return Promise.all(steps).then(function done() {
      return undefined;
    });
  });
}

/**
 * Email the digest to accepted participants who opted in, once per person per day.
 * @param {Array<object>} workshops - The digest's workshops.
 * @param {{today: Date, dateKey: string}} due - Today's digest time.
 * @returns {Promise<number>} Emails queued.
 */
function sendDigestEmails(workshops, due) {
  return Application.distinct("applicant", { status: "accepted" })
    .then(function afterAccepted(ids) {
      return User.find({ _id: { $in: ids }, marketingEmailConsent: true }).select("name email").lean();
    })
    .then(function claimEach(users) {
      var mine = [];
      return users
        .reduce(function claimOne(p, user) {
          return p.then(function tryClaim() {
            return claim({
              key: "workshop_digest_email:" + due.dateKey + ":" + String(user._id),
              kind: "workshop_digest_email",
              user: user._id,
              scheduledFor: due.today,
              status: "sent",
            }).then(function afterClaim(won) {
              if (won) {
                mine.push(user);
              }
            });
          });
        }, Promise.resolve())
        .then(function queue() {
          var lines = digestLines(workshops);
          return outbox.enqueueMany(
            mine.map(function toEntry(user) {
              return {
                to: user.email,
                user: user._id,
                templateKey: "workshop_digest",
                category: "announcement",
                values: { name: user.name || "there", workshops: lines, workshopsUrl: workshopsUrl() },
              };
            }),
            { batchId: "workshop_digest:" + due.dateKey }
          );
        });
    });
}

/**
 * Post to the workshops channel when a workshop is published, or a published
 * one moves (time or room). Called by the workshop controller after a save;
 * never throws and never delays the response. Each version is posted once.
 * @param {object} workshop - The saved Workshop document.
 * @param {string} kind - "published" | "changed".
 * @returns {Promise<void>}
 */
function notifyWorkshopUpdate(workshop, kind) {
  return Promise.all([CommunicationSettings.getSingleton(), orgSettingsCache.get()])
    .then(function afterSettings(loaded) {
      var settings = loaded[0];
      if (
        !settings.updatesDiscord.enabled ||
        !features.isEnabled(loaded[1], "workshops") ||
        !discordAnnouncements.isConfigured("discord_workshops") ||
        !workshop.published ||
        workshop.cancelled ||
        new Date(workshop.endsAt) < new Date()
      ) {
        return undefined;
      }
      var key =
        "workshop_update_discord:" +
        String(workshop._id) +
        ":" +
        kind +
        ":" +
        new Date(workshop.startsAt).toISOString() +
        ":" +
        (workshop.location || "");
      return claim({ key: key, kind: "workshop_update_discord", workshop: workshop._id }).then(function afterClaim(won) {
        if (!won) {
          return undefined;
        }
        var when = calendar.formatTimeRange(workshop.startsAt, workshop.endsAt);
        var lines = [
          (kind === "published" ? "New workshop: " : "New time or room: ") + workshop.title,
          "When: " + when,
          workshop.location ? "Where: " + workshop.location : "",
          workshop.host ? "Host: " + workshop.host : "",
        ].filter(Boolean);
        var left = spotsLeft(workshop);
        if (left !== null) {
          lines.push(left === 0 ? "It's full." : left + (left === 1 ? " spot left." : " spots left."));
        }
        lines.push("Sign up on the dashboard: " + workshopUrl(workshop._id));
        return brandColor().then(function post(color) {
          return discordAnnouncements
            .send("discord_workshops", {
              title: (kind === "published" ? "New workshop: " : "Workshop moved: ") + workshop.title,
              description: lines.join("\n"),
              url: workshopUrl(workshop._id),
              color: color,
            })
            .then(function record(outcome) {
              return settle(key, { status: outcome.status, error: outcome.error, messageId: outcome.messageId });
            });
        });
      });
    })
    .catch(function onError(err) {
      console.error("Workshop update post failed:", err && err.message);
    });
}

/**
 * Run the workshop automations once.
 * @param {Date} [at] - Pretend it is this time (tests).
 * @returns {Promise<void>}
 */
function runWorkshopAutomations(at) {
  var now = at || new Date();
  return Promise.all([CommunicationSettings.getSingleton(), orgSettingsCache.get()]).then(function afterSettings(loaded) {
    if (!features.isEnabled(loaded[1], "workshops")) {
      return undefined;
    }
    var settings = loaded[0];
    return runReminderEmails(settings, now)
      .then(function discord() {
        return runReminderDiscord(settings, now);
      })
      .then(function digest() {
        return runDigest(settings, now);
      });
  });
}

/**
 * One scheduler tick: due announcements, then workshop automations. Only one
 * tick runs at a time in a process; the claims make two processes safe.
 * @param {Date} [at] - Pretend it is this time (tests; announcements always use the real time).
 * @returns {Promise<void>}
 */
function tick(at) {
  if (running) {
    return running;
  }
  running = sendDueAnnouncements()
    .then(function automations() {
      return runWorkshopAutomations(at);
    })
    .catch(function onError(err) {
      console.error("Communications scheduler run failed:", err);
    })
    .then(function done() {
      running = null;
    });
  return running;
}

/**
 * Start the scheduler: every COMMUNICATIONS_INTERVAL_MS (default one minute).
 * @returns {void}
 */
function startWorker() {
  if (timer) {
    return;
  }
  var every = Number(process.env.COMMUNICATIONS_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  timer = setInterval(function run() {
    tick();
  }, every);
  if (timer.unref) {
    timer.unref();
  }
  setImmediate(function first() {
    tick();
  });
}

/**
 * Stop the scheduler (tests).
 * @returns {void}
 */
function stopWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// ---- What happens next ------------------------------------------------------

/**
 * The next automated sends and scheduled announcements, soonest first, for
 * the page ("Next: Playbook reminder at 8:45 PM to 12 people + Discord").
 * @param {Date} [at] - Pretend it is this time (tests).
 * @returns {Promise<Array<object>>} `{ at, kind, label, channels, recipients, workshop? }`.
 */
function upcoming(at) {
  var now = at || new Date();
  return Promise.all([
    CommunicationSettings.getSingleton(),
    channelStatus(),
    Announcement.find({ status: "scheduled" }).sort({ scheduledFor: 1 }).limit(10).lean(),
    Workshop.find({
      published: true,
      cancelled: false,
      startsAt: { $gt: now, $lte: new Date(now.getTime() + NEXT_HORIZON_MS) },
    })
      .sort({ startsAt: 1 })
      .limit(30)
      .lean(),
  ]).then(function build(loaded) {
    var settings = loaded[0];
    var channels = loaded[1];
    var items = loaded[2].map(function announcement(a) {
      return {
        at: a.scheduledFor,
        kind: "announcement",
        id: String(a._id),
        label: a.title,
        channels: a.channels,
        audienceLabel: a.channels.indexOf("email") !== -1 ? a.audienceLabel : "",
      };
    });
    var workshops = loaded[3];
    if (!channels.workshops) {
      return items;
    }
    var emailOn = settings.reminderEmail.enabled && channels.email;
    var discordOn = settings.reminderDiscord.enabled && channels.discord_workshops;

    return AutomationLog.find({
      workshop: {
        $in: workshops.map(function pick(w) {
          return w._id;
        }),
      },
      kind: { $in: ["workshop_reminder_email", "workshop_reminder_discord"] },
    })
      .select("key kind")
      .lean()
      .then(function addWorkshops(logs) {
        var done = {};
        logs.forEach(function mark(log) {
          done[log.key] = true;
        });
        workshops.forEach(function each(workshop) {
          var prefix = reminderKey("workshop_reminder_email", workshop) + ":";
          var alreadyEmailed = logs.filter(function mine(log) {
            return log.key.indexOf(prefix) === 0;
          }).length;
          var people = Math.max(0, (workshop.signupCount || 0) - alreadyEmailed);
          var emailAt = new Date(new Date(workshop.startsAt).getTime() - settings.reminderEmail.minutesBefore * MINUTE_MS);
          var discordAt = new Date(new Date(workshop.startsAt).getTime() - settings.reminderDiscord.minutesBefore * MINUTE_MS);
          var discordPending = discordOn && !done[reminderKey("workshop_reminder_discord", workshop)];
          var emailPending = emailOn && people > 0;
          if (!emailPending && !discordPending) {
            return;
          }
          var sameTime = emailPending && discordPending && +emailAt === +discordAt;
          if (emailPending) {
            items.push({
              at: emailAt < now ? now : emailAt,
              kind: "workshop_reminder",
              workshop: String(workshop._id),
              label: workshop.title + " reminder",
              channels: sameTime ? ["email", "discord_workshops"] : ["email"],
              recipients: people,
            });
          }
          if (discordPending && !sameTime) {
            items.push({
              at: discordAt < now ? now : discordAt,
              kind: "workshop_reminder",
              workshop: String(workshop._id),
              label: workshop.title + " starting soon post",
              channels: ["discord_workshops"],
            });
          }
        });

        var digestDiscord = settings.digestDiscord.enabled && channels.discord_workshops;
        var digestEmail = settings.digestEmail.enabled && channels.email;
        if (digestDiscord || digestEmail) {
          var due = digestTimeToday(settings, now);
          var next = due.today;
          if (now.getTime() - due.today.getTime() > 0) {
            var tomorrow = zonedParts(new Date(due.today.getTime() + 26 * HOUR_MS));
            var hm = settings.digestDiscord.time.split(":");
            next = zonedTime(tomorrow.year, tomorrow.month, tomorrow.day, Number(hm[0]), Number(hm[1]));
          }
          var digestChannels = [];
          if (digestEmail) {
            digestChannels.push("email");
          }
          if (digestDiscord) {
            digestChannels.push("discord_workshops");
          }
          items.push({ at: next, kind: "digest", label: "Workshop sign-up digest", channels: digestChannels });
        }

        return items
          .sort(function byTime(a, b) {
            return new Date(a.at) - new Date(b.at);
          })
          .slice(0, 15);
      });
  });
}

module.exports = {
  validateSettings: validateSettings,
  serializeSettings: serializeSettings,
  channelStatus: channelStatus,
  listAudiences: listAudiences,
  validateAudience: validateAudience,
  resolveAudience: resolveAudience,
  countAudience: countAudience,
  preview: preview,
  dispatch: dispatch,
  claimAnnouncement: claimAnnouncement,
  sendDueAnnouncements: sendDueAnnouncements,
  emailStatusCounts: emailStatusCounts,
  runWorkshopAutomations: runWorkshopAutomations,
  notifyWorkshopUpdate: notifyWorkshopUpdate,
  startingSoonText: startingSoonText,
  tick: tick,
  startWorker: startWorker,
  stopWorker: stopWorker,
  upcoming: upcoming,
  zonedTime: zonedTime,
  zonedParts: zonedParts,
};
