"use strict";
var mongoose = require("mongoose");
var Room = require("../../schemas/judgingRoom");
var Project = require("../../schemas/project");

/** @param {object[]} rooms - Ordered rooms. @returns {object[]} Global table layout. */
function layout(rooms) {
  var number = 0;
  var tables = [];
  rooms.forEach(function roomTables(room) {
    for (var i = 0; i < room.capacity; i++) {
      tables.push({ number: ++number, room: room._id, hardware: room.hardware });
    }
  });
  return tables;
}
function problem(message) {
  var err = new Error(message);
  err.status = 409;
  return err;
}
async function allocate(id, session, both, actor) {
  var project = await Project.findById(id).session(session);
  if (!project || project.withdrawn) throw problem("Project not found or withdrawn.");
  if (project.team) {
    await require("../../schemas/team").updateOne({ _id: project.team, lockedAt: null }, { $set: { lockedAt: new Date(), lockedBy: actor } }, { session: session });
  }
  var changed = !project.deskCheckedInAt;
  var values = {};
  if (!project.tableNumber) {
    var rooms = await Room.find({}).sort({ order: 1, name: 1, _id: 1 }).session(session).lean();
    var occupied = await Project.distinct("tableNumber", { tableNumber: { $type: "number" } }).session(session);
    var table = layout(rooms).find(function available(t) {
      return t.hardware === project.hardware && !occupied.includes(t.number);
    });
    if (!table) throw problem(project.hardware ? "Hardware rooms are full." : "Judging rooms are full.");
    values.room = table.room;
    values.tableNumber = table.number;
  }
  if (changed) values.deskCheckedInAt = new Date();
  if (both && !project.tableCheckedInAt) values.tableCheckedInAt = new Date();
  var updated = await Project.findOneAndUpdate({ _id: id, tableNumber: project.tableNumber || null, deskCheckedInAt: project.deskCheckedInAt || null, hardware: project.hardware, withdrawn: false }, { $set: values }, { new: true, session: session });
  if (!updated) throw Object.assign(new Error("Assignment changed. Retry."), { code: 11000 });
  return { project: updated, changed: changed };
}
/** @param {object|string} id - Project id. @param {boolean} both - Complete both steps. @param {object|string} actor - Staff id. @returns {Promise<object>} Assignment and email claim. */
async function assignLocked(id, both, actor) {
  var transactions = true;
  for (var attempt = 0; attempt < 60; attempt++) {
    var session = transactions ? await mongoose.startSession() : null;
    try {
      var result;
      if (session) {
        await session.withTransaction(async function write() { result = await allocate(id, session, both, actor); });
      } else result = await allocate(id, null, both, actor);
      return result;
    } catch (err) {
      if (transactions && (err.code === 20 || /Transaction numbers are only allowed|does not support transactions/i.test(err.message))) {
        transactions = false;
        continue;
      }
      if (err.code === 11000 || err.code === 112 || (err.hasErrorLabel && err.hasErrorLabel("TransientTransactionError"))) continue;
      throw err;
    } finally {
      if (session) await session.endSession();
    }
  }
  throw problem("Tables are busy. Scan again.");
}
/** @param {object|string} id - Project. @param {boolean} both - Both check-ins. @param {object|string} actor - Staff. @returns {Promise<object>} Allocation. */
function assign(id, both, actor) {
  return require("./state").locked(function allocateLocked() { return assignLocked(id, both, actor); });
}
module.exports = { layout: layout, assign: assign };
