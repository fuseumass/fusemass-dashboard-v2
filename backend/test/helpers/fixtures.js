"use strict";

var User = require("../../schemas/user");
var signToken = require("../../utils/signToken");

/**
 * Create a user directly in the test database and sign a JWT for it, so
 * tests can hit guarded routes without going through register/login.
 * @param {object} [overrides] - Fields to override (name, email, role).
 * @returns {Promise<{user: object, token: string}>}
 */
function createUser(overrides) {
  var fields = Object.assign(
    {
      name: "Test User",
      email: "user-" + Date.now() + "-" + Math.random().toString(36).slice(2) + "@example.com",
      role: "applicant",
    },
    overrides || {}
  );

  return User.create(fields).then(function afterCreate(user) {
    var token = signToken({ id: String(user._id), email: user.email, role: user.role });
    return { user: user, token: token };
  });
}

module.exports = { createUser: createUser };
