"use strict";

var User = require("../../schemas/user");
var signToken = require("../../utils/signToken");

// A real bcrypt hash (of "test-password"), so fixture users look like people
// who registered. Without one a user counts as "applied without an account",
// which changes what acceptance sends. Computed once: bcrypt is slow on purpose.
var passwordHashPromise = null;

/**
 * Create a user directly in the test database and sign a JWT for it, so
 * tests can hit guarded routes without going through register/login.
 * @param {object} [overrides] - Fields to override (name, email, role,
 *   passwordHash; pass `passwordHash: undefined` for a passwordless account).
 * @returns {Promise<{user: object, token: string}>}
 */
function createUser(overrides) {
  passwordHashPromise = passwordHashPromise || User.hashPassword("test-password");

  return passwordHashPromise.then(function afterHash(passwordHash) {
    return createUserWithHash(passwordHash, overrides);
  });
}

/**
 * @param {string} passwordHash - Default password hash for the user.
 * @param {object} [overrides] - See createUser.
 * @returns {Promise<{user: object, token: string}>}
 */
function createUserWithHash(passwordHash, overrides) {
  var fields = Object.assign(
    {
      name: "Test User",
      email: "user-" + Date.now() + "-" + Math.random().toString(36).slice(2) + "@example.com",
      role: "applicant",
      passwordHash: passwordHash,
    },
    overrides || {}
  );

  return User.create(fields).then(function afterCreate(user) {
    var token = signToken({ id: String(user._id), email: user.email, role: user.role });
    return { user: user, token: token };
  });
}

module.exports = { createUser: createUser };
