"use strict";

var User = require("../schemas/user");

/*
 * Discord OAuth token lifecycle:
 *
 * - Authorization code: short-lived, one-time code returned by Discord after
 *   the user authorizes the application. Exchange it for tokens.
 * - Access token: short-lived token used in the Bearer header to request the
 *   user's Discord information. It can be obtained from an authorization code
 *   or by exchanging a refresh token.
 * - Refresh token: longer-lived token used to obtain a new access token after
 *   the current access token expires. It is not used to request user data
 *   directly and must be stored securely.
 *
 * The callback below exchanges the authorization code for an access token,
 * then uses that access token to retrieve the user's Discord information.
 */

/**
 * POST /api/discord/callback
 * Exchange a Discord OAuth authorization code and return the linked user.
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
async function handler(req, res) { //for currently logged in user, map user id (mongodb ID) to discordID
  // The frontend sends the one-time OAuth authorization code in the POST body.
  var code = req.body && req.body.code;
  if (!code) {

    res.status(400).json({ error: "Discord authorization code is required." });
    return;
  }
 
  try { //Get access token, refresh token
    var tokenResponse = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_APP_CLIENT_ID,
        client_secret: process.env.DISCORD_APP_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: process.env.DISCORD_REDIRECT_URI
      }),
    });

    if (!tokenResponse.ok) {
      console.log("ERR")
      res.status(502).json({ error: "Could not exchange the Discord authorization code." });
      return;
    }
    console.log("SUCCESS")

    // The response contains both the short-lived access token and the
    // longer-lived refresh token. Keep the refresh token private.
    var tokenData = await tokenResponse.json();
    var accessToken = tokenData.access_token;

    if (!accessToken) {
      res.status(502).json({ error: "Discord did not return an access token." });
      return;
    }

    // User information must be requested with the access token, not the code
    // or refresh token.
    var userResponse = await fetch("https://discord.com/api/v10/users/@me", {
      headers: {
        Authorization: "Bearer " + accessToken,
      },
    });

    if (!userResponse.ok) {
      res.status(502).json({ error: "Could not retrieve the Discord user." });
      return;
    }

    var user = await userResponse.json();
    var discordId = user.id;
    if (!discordId) {
      res.status(502).json({ error: "Discord did not return a user ID." });
      return;
    }

    var currentUser = await User.findById(req.user.id); //get the current user's document
    if (!currentUser) {
      res.status(404).json({ error: "User account not found." });
      return;
    }

    // Store Discord's ID on the currently authenticated MongoDB user.
    currentUser.discordId = String(discordId);
    await currentUser.save();
    res.status(200).json({ user: discordId });
  } catch (err) {
    console.error("Discord OAuth callback failed:", err);
    res.status(502).json({ error: "Could not link the Discord account." });
  }
}

module.exports = handler;
