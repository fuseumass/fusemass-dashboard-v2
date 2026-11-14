# Discord bot

Slash commands for the hardware desk: `/inventory <item>` and `/checkedout`
(replies only the person who asked sees). Based on
[noahshayne/DiscordBot](https://github.com/noahshayne/DiscordBot). It only
reads the dashboard database; account linking is the dashboard's Discord module
(`/api/discord/*`, home page card).

## Settings (in the backend `.env`, also editable in System settings > Discord)

| Variable | What |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Developer Portal > your app > Bot > Reset Token |
| `DISCORD_GUILD_ID` | Optional. Your server's ID (Developer Mode > right-click server > Copy Server ID) |
| `DISCORD_APP_CLIENT_ID` / `DISCORD_APP_CLIENT_SECRET` | Developer Portal > OAuth2 (for account linking) |
| `DISCORD_REDIRECT_URI` | Optional. Defaults to `<frontend>/dashboard/discord`; add it under OAuth2 > Redirects |

`MONGODB_URI` and `ORG_NAME` are read from the same file. Invite the bot with
the `bot` and `applications.commands` scopes.

## Run locally

    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
    ENV_FILE=../backend/.env .venv/bin/python main.py
