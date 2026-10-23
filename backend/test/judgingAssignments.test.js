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

function fixture(count, capacities, judgeCount, offset) {
  return {
    teams: Array.from({ length: count }, function team(_, i) {
      return { name: "Team " + (i + offset), tableNumber: i + offset };
    }),
    judges: Array.from({ length: judgeCount }, function judge(_, i) { return { name: "Judge " + i }; }),
    numRooms: capacities.length,
    roomCapacities: capacities,
    judgingsPerProject: 3,
    rng: seeded(2025)
  };
}

function invariants(config, rows) {
  var counts = {};
  var slots = [];
  var loads = [];
  rows.forEach(function row(assignments) {
    var seen = new Set();
    var load = 0;
    assignments.forEach(function assignment(table, slot) {
      if (table === -1) return;
      assert.ok(config.teams.some(function team(t) { return t.tableNumber === table; }), "table belongs to this room pool");
      assert.ok(!seen.has(table), "judge never repeats a team");
      seen.add(table);
      slots[slot] = slots[slot] || new Set();
      assert.ok(!slots[slot].has(table), "table never double booked");
      slots[slot].add(table);
      counts[table] = (counts[table] || 0) + 1;
      load++;
    });
    loads.push(load);
  });
  config.teams.forEach(function team(t) { assert.equal(counts[t.tableNumber], config.judgingsPerProject); });
  var average = loads.reduce(function sum(a, b) { return a + b; }, 0) / loads.length;
  loads.forEach(function load(n) { assert.ok(Math.abs(n - average) <= 2); });
}

// Characterized BEFORE repairing the verifier. Regular judges rotate through the
// five rooms, rather than belonging to a fixed room. Hardware is a separate run.
// Capacities total 177 regular + 31 hardware; 137 + 23 occupied tables models
// ~160 checked-in teams, while the full-capacity cases cover all six rooms.
// Before the verifier fix, the 6-team seed reported success but failed the
// simultaneous-slot invariant. The larger fixtures passed the straight port.
[ [137, [33, 49, 33, 40, 22], 25, 1], [23, [31], 6, 178],
  [177, [33, 49, 33, 40, 22], 30, 1], [31, [31], 6, 178],
  [6, [3, 3], 3, 1] ].forEach(function shape(args) {
  test("seeded characterization " + args[0] + " teams", function characterize() {
    var config = fixture.apply(null, args);
    var result = judging.generateJudgingAssignments(config);
    assert.equal(result.success, true, JSON.stringify(result.issues));
    invariants(config, result.assignments.map(function row(j) { return j.slots; }));
    assert.deepEqual(result, judging.generateJudgingAssignments(fixture.apply(null, args)));
  });
});

function system(count, judges, required) {
  var config = fixture(count, [count], judges, 1);
  return { projects: config.teams, judges: config.judges, judgingsPerProject: required };
}

test("repair checks the destination slot (original returned success with a clash)", function repair() {
  // Original appends table 1 to judge 1 at index 1 because index 0 is
  // collision-free. Judge 2 already sees table 1 at index 1. Counts pass,
  // and the original verifier returns success without rerunning other checks.
  var input = [[2], [3, 1], [-1, 2, 3]];
  var before = JSON.stringify(input);
  var verifier = new judging.AssignmentVerifier(system(3, 3, 2), input);
  var result = verifier.verifyAll();
  assert.equal(result.success, true);
  assert.deepEqual(result.assignments, [[2], [3, 1], [1, 2, 3]]);
  assert.equal(verifier._verifySimultaneousJudging().length, 0);
  assert.equal(JSON.stringify(input), before);
});

test("impossible repair throws naming the team", function impossible() {
  assert.throws(function verify() {
    new judging.AssignmentVerifier(system(1, 1, 2), [[1]]).verifyAll();
  }, /Table 1 \(Team 1\).*cannot place/);
});

test("repair rechecks existing clashes, starts, repeats and workload", function rechecks() {
  [ [[2], [2], []], [[2, 2], [], []],
    [[2, -1, -1, -1, -1, -1, -1], [2], []] ].forEach(function schedule(rows) {
    assert.throws(function verify() {
      new judging.AssignmentVerifier(system(3, 3, 2), rows).verifyAll();
    }, /Table .*invalid repaired schedule/);
  });
});

test("repair reruns workload verification", function workload() {
  assert.throws(function verify() {
    new judging.AssignmentVerifier(system(8, 3, 1), [[1, 2, 3, 4, 5, 6], [7], []]).verifyAll();
  }, /Table 8 \(Team 8\).*Judge .*average/);
});

test("repair fills a free existing slot without overwriting visits", function freeSlot() {
  var result = new judging.AssignmentVerifier(system(2, 2, 1), [[-1, 2], []]).verifyAll();
  assert.equal(result.success, true);
  assert.deepEqual(result.assignments, [[1, 2], []]);
});
