"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var linkReissue = require("../utils/linkReissue");
var User = require("../schemas/user");

test("fresh links for retried single-use emails", async function (t) {
  await db.connect();
  t.after(db.closeDatabase);
  await db.clearDatabase();

  assert.equal(linkReissue.canReissue("judge_invite"), true);
  assert.equal(linkReissue.canReissue("account_setup_reminder"), true);
  assert.equal(linkReissue.canReissue("password_reset"), false, "people ask for these again themselves");
  assert.equal(linkReissue.canReissue("verify_email"), false);

  var judge = await fixtures.createUser({ role: "judge", email: "judge@example.com", name: "Jo Judge" });
  await User.updateOne({ _id: judge.user._id }, { $set: { judgeInvitePending: true } });
  var fresh = await linkReissue.freshValues({ to: "judge@example.com", user: judge.user._id, templateKey: "judge_invite" });
  assert.equal(fresh.values.name, "Jo Judge");
  assert.match(fresh.values.inviteUrl, /\/judge\/accept\?token=[a-f0-9]+$/);

  await User.updateOne({ _id: judge.user._id }, { $set: { judgeInvitePending: false } });
  var done = await linkReissue.freshValues({ to: "judge@example.com", user: judge.user._id, templateKey: "judge_invite" });
  assert.match(done.skip, /accepted the invite/);

  var gone = await linkReissue.freshValues({ to: "nobody@example.com", templateKey: "account_setup" });
  assert.match(gone.skip, /no account/);
});
