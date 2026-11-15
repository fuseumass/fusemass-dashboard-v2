"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var judging = require("../utils/judging/assignments");

function seeded(seed) {
  return function random() {
    var t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Rooms in walking order, each a list of occupied tables (with vacancies).
function setup(ranges, occupancy, judges, k, strategy) {
  var rng = seeded(11);
  var rooms = ranges.map(function room(r) {
    var tables = [];
    for (var n = r[0]; n <= r[1]; n++) if (rng() < occupancy) tables.push(n);
    return tables;
  });
  var teams = [].concat.apply([], rooms).map(function team(n) { return { name: "T" + n, tableNumber: n }; });
  var result = judging.generateJudgingAssignments({
    teams: teams,
    judges: Array.from({ length: judges }, function judge(_, i) { return { name: "J" + i }; }),
    judgingsPerProject: k, numRooms: rooms.length,
    roomCapacities: ranges.map(function cap(r) { return r[1] - r[0] + 1; }), roomTables: rooms,
    rng: seeded(5), strategy: strategy,
  });
  var roomOf = {};
  var position = {};
  var line = [];
  rooms.forEach(function index(tables, i) { tables.forEach(function at(n) { roomOf[n] = i; position[n] = line.length; line.push(n); }); });
  return { result: result, rooms: rooms, teams: teams, roomOf: roomOf, position: position, size: line.length };
}

function roomChanges(queue, roomOf) {
  var changes = 0;
  for (var i = 1; i < queue.length; i++) if (roomOf[queue[i]] !== roomOf[queue[i - 1]]) changes++;
  return changes;
}

test("sweep: exact coverage, no repeats or double-booking, judges walk neighbouring tables", function () {
  // Five software rooms in walking order plus a one-table room, ~85% occupied.
  var s = setup([[1, 22], [23, 50], [51, 72], [73, 98], [99, 99], [100, 140]], 0.85, 45, 3);
  assert.equal(s.result.success, true, s.result.issues.join("; "));
  assert.ok(s.result.log.some(function sweep(line) { return /Walking sweep: verified/.test(line); }));
  var counts = {};
  s.result.assignments.forEach(function judge(a) {
    assert.equal(new Set(a.assignments).size, a.assignments.length, "a judge never repeats a project");
    a.assignments.forEach(function count(n) { counts[n] = (counts[n] || 0) + 1; });
    // Each queue follows the walking line: every step is the next table (one wrap allowed).
    var jumps = 0;
    for (var i = 1; i < a.assignments.length; i++) {
      if (s.position[a.assignments[i]] !== (s.position[a.assignments[i - 1]] + 1) % s.size) jumps++;
    }
    assert.equal(jumps, 0, "judges move to the next table in walking order");
    assert.ok(roomChanges(a.assignments, s.roomOf) <= 2);
  });
  s.teams.forEach(function covered(t) { assert.equal(counts[t.tableNumber], 3); });
  // Same slot, different tables (the verifier also checks this).
  var longest = Math.max.apply(null, s.result.assignments.map(function len(a) { return a.slots.length; }));
  for (var slot = 0; slot < longest; slot++) {
    var here = s.result.assignments.map(function at(a) { return a.slots[slot]; }).filter(function real(n) { return n !== undefined && n !== -1; });
    assert.equal(new Set(here).size, here.length);
  }
  var average = s.result.assignments.reduce(function sum(t, a) { return t + roomChanges(a.assignments, s.roomOf); }, 0) / s.result.assignments.length;
  assert.ok(average < 0.6, "far fewer room changes than visiting every room (" + average + ")");
});

test("sweep beats room rotation on room changes for the same pool", function () {
  var ranges = [[1, 22], [23, 50], [51, 72], [73, 98]];
  var sweep = setup(ranges, 0.9, 40, 3, "sweep");
  var rotation = setup(ranges, 0.9, 40, 3, "rotation");
  assert.equal(sweep.result.success, true);
  assert.equal(rotation.result.success, true, "the fallback still works");
  function total(s) { return s.result.assignments.reduce(function sum(t, a) { return t + roomChanges(a.assignments, s.roomOf); }, 0); }
  assert.ok(total(sweep) < total(rotation) / 3, total(sweep) + " vs " + total(rotation));
});

test("sweep follows room walking order, not table numbers", function () {
  // The hardware room walked first has the higher numbers.
  var s = setup([[300, 304], [1, 5]], 1, 2, 1);
  assert.equal(s.result.success, true);
  var all = s.result.assignments.map(function q(a) { return a.assignments; });
  assert.deepEqual(all, [[300, 301, 302, 303, 304], [1, 2, 3, 4, 5]]);
});

test("sweep handles more judges than tables by letting extra judges start later", function () {
  var s = setup([[1, 4]], 1, 6, 2);
  assert.equal(s.result.success, true, s.result.issues.join("; "));
  var counts = {};
  s.result.assignments.forEach(function judge(a) { a.assignments.forEach(function c(n) { counts[n] = (counts[n] || 0) + 1; }); });
  assert.deepEqual(counts, { 1: 2, 2: 2, 3: 2, 4: 2 });
});
