"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var computeBias = require("../utils/judging/bias").computeBias;

function scores(n, category) {
  return { score1: n, score2: n, score3: n, score4: n, score5: n, score6: category };
}

test("three judges and three rounds reproduce hand computed biases", function calibration() {
  // General means per round: [2,4,6], [3,5,7], [4,6,8].
  // Overall means: 4,5,6; each judge's differences average to -2,0,+2.
  // Category rounds: [1,4,7], [2,5,8], [3,6,9]; means 4,5,6.
  // Category differences average to -3,0,+3.
  var input = {
    strict: [scores(2, 1), scores(3, 2), scores(4, 3)],
    middle: [scores(4, 4), scores(5, 5), scores(6, 6)],
    generous: [scores(6, 7), scores(7, 8), scores(8, 9)],
    absent: []
  };
  var before = JSON.stringify(input);
  assert.deepEqual(computeBias(input), {
    strict: { general: -2, category: -3 },
    middle: { general: 0, category: 0 },
    generous: { general: 2, category: 3 }, absent: null
  });
  assert.equal(JSON.stringify(input), before);
});

test("empty and single judge inputs", function edges() {
  assert.deepEqual(computeBias({}), {});
  assert.deepEqual(computeBias({ absent: [] }), { absent: null });
  assert.deepEqual(computeBias({ solo: [scores(4, 8), scores(8, 2)] }), {
    solo: { general: 0, category: 0 }
  });
});

test("uneven rounds and missing criteria preserve the original weighting", function partial() {
  // Round 1: A mean (2+4)/2=3, B mean 7; overall 5 => -2,+2.
  // Round 2: only A, difference 0. A bias (-2+0)/2=-1; B=2.
  // Only B has a category score: its difference is 0. Missing groups default 0.
  assert.deepEqual(computeBias({ a: [{ x: 2, y: 4 }, { x: 9 }],
    b: [{ x: 7, c: 8 }], emptyRound: [{}] }, { general: ["x", "y"], category: "c" }), {
    a: { general: -1, category: 0 }, b: { general: 2, category: 0 },
    emptyRound: { general: 0, category: 0 }
  });
});
