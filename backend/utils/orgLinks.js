"use strict";

var branding = require("./branding");

/**
 * The hackathon's community links, read from the server env at request time:
 *
 *   ORG_WEBSITE_URL            the public website
 *   ORG_DISCORD_URL            the Discord invite
 *   ORG_DISCORD_MENTORSHIP_URL optional: the mentorship channel / ticket-bot link (B31)
 *
 * Mentorship tickets are created on Discord, not in the dashboard, so this is
 * all the dashboard does for them: link to it. A link that isn't a plain
 * http(s) URL (or is unset) comes back as null, so the page can simply not
 * show it.
 *
 * @returns {{websiteUrl: (string|null), discordUrl: (string|null), mentorshipUrl: (string|null)}}
 */
function getLinks() {
  return {
    websiteUrl: branding.cleanUrl(process.env.ORG_WEBSITE_URL, true),
    discordUrl: branding.cleanUrl(process.env.ORG_DISCORD_URL, true),
    mentorshipUrl: branding.cleanUrl(process.env.ORG_DISCORD_MENTORSHIP_URL, true),
  };
}

module.exports = {
  getLinks: getLinks,
};
