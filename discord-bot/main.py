"""Discord bot for the dashboard's hardware desk.

Based on https://github.com/noahshayne/DiscordBot (Noah Shayne, commit 575c2b1).

Slash commands (replies are only visible to the person who ran them):
  /inventory <name>  How many of a hardware item are available.
  /checkedout        The hardware currently checked out to you. Needs your
                     Discord account linked on the dashboard home page.

It only reads the dashboard database. Settings come from the backend's .env
(ENV_FILE, default ../backend/.env):
  DISCORD_BOT_TOKEN  Bot token (DISCORD_TOKEN also works).
  DISCORD_GUILD_ID   Optional: your server's ID, so commands appear there at once.
  MONGODB_URI        The dashboard database (already set for the backend).
  ORG_NAME           Shown in replies (already set for the backend).
Turning the Discord module off in General settings makes both commands say so.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
from pathlib import Path

import discord
from discord import app_commands
from discord.ext import commands
from dotenv import load_dotenv
from pymongo import MongoClient
from pymongo.errors import PyMongoError

HERE = Path(__file__).resolve().parent
load_dotenv(os.getenv("ENV_FILE") or HERE.parent / "backend" / ".env")

TOKEN = os.getenv("DISCORD_BOT_TOKEN") or os.getenv("DISCORD_TOKEN")
MONGODB_URI = os.getenv("MONGODB_URI")
ORG_NAME = os.getenv("ORG_NAME") or "the hackathon"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s:%(name)s: %(message)s")

bot = commands.Bot(command_prefix="!", intents=discord.Intents.default())
mongo = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000) if MONGODB_URI else None


def _db():
    if mongo is None:
        raise RuntimeError("MONGODB_URI is not set.")
    # The database named in MONGODB_URI (e.g. .../hackdash), like the backend.
    return mongo.get_default_database(os.getenv("MONGODB_DATABASE") or "hackdash")


def _module_on() -> bool:
    """The Discord module is off only when General settings says so explicitly."""
    settings = _db()["orgsettings"].find_one({"key": "default"}, {"features": 1}) or {}
    return (settings.get("features") or {}).get("discord") is not False


def _available(name: str) -> int | None:
    item = _db()["hardwareitems"].find_one({"name": name, "archived": {"$ne": True}}, {"availableQty": 1})
    return None if item is None else int(item.get("availableQty") or 0)


def _suggestions(current: str) -> list[str]:
    query = {"archived": {"$ne": True}, "name": {"$regex": "^" + re.escape(current.strip()), "$options": "i"}}
    return [i["name"] for i in _db()["hardwareitems"].find(query, {"name": 1}).sort("name", 1).limit(25) if isinstance(i.get("name"), str)]


def _checked_out(discord_id: str) -> list[str] | None:
    """Names of the open loans of the linked dashboard user, or None if not linked."""
    user = _db()["users"].find_one({"discordId": discord_id}, {"_id": 1})
    if user is None:
        return None
    loans = list(_db()["hardwarecheckouts"].find({"user": user["_id"], "returnedAt": None}, {"item": 1}))
    ids = [loan["item"] for loan in loans if loan.get("item") is not None]
    names = {i["_id"]: i.get("name", "an item") for i in _db()["hardwareitems"].find({"_id": {"$in": ids}}, {"name": 1})}
    return [names.get(item_id, "an item") for item_id in ids]


OFF = "Discord commands are turned off right now."
BROKEN = "Couldn't reach the hardware inventory. Try again in a minute."


@bot.event
async def on_ready() -> None:
    logging.info("Logged in as %s (ID: %s)", bot.user, bot.user.id)
    guild_id = os.getenv("DISCORD_GUILD_ID")
    try:
        if guild_id:
            guild = discord.Object(id=int(guild_id))
            bot.tree.copy_global_to(guild=guild)
            synced = await bot.tree.sync(guild=guild)
        else:
            synced = await bot.tree.sync()
        logging.info("Synced %d commands", len(synced))
    except (ValueError, discord.DiscordException):
        logging.exception("Failed to sync commands")


@bot.tree.command(name="inventory", description="How many of a hardware item are available")
@app_commands.describe(name="Hardware item name")
async def inventory(interaction: discord.Interaction, name: str) -> None:
    name = name.strip()
    try:
        if not await asyncio.to_thread(_module_on):
            await interaction.response.send_message(OFF, ephemeral=True)
            return
        if not name:
            await interaction.response.send_message("Type a hardware item name.", ephemeral=True)
            return
        qty = await asyncio.to_thread(_available, name)
    except (PyMongoError, RuntimeError):
        logging.exception("/inventory failed")
        await interaction.response.send_message(BROKEN, ephemeral=True)
        return
    if qty is None:
        await interaction.response.send_message(f"No hardware item is called **{name}**. Pick one from the suggestions.", ephemeral=True)
        return
    await interaction.response.send_message(f"**{name}**: {qty} available at the hardware desk.", ephemeral=True)


@inventory.autocomplete("name")
async def inventory_autocomplete(interaction: discord.Interaction, current: str) -> list[app_commands.Choice[str]]:
    try:
        names = await asyncio.to_thread(_suggestions, current)
    except (PyMongoError, RuntimeError):
        logging.exception("/inventory autocomplete failed")
        return []
    return [app_commands.Choice(name=n[:100], value=n[:100]) for n in names]


@bot.tree.command(name="checkedout", description="The hardware you have checked out")
async def checkedout(interaction: discord.Interaction) -> None:
    try:
        if not await asyncio.to_thread(_module_on):
            await interaction.response.send_message(OFF, ephemeral=True)
            return
        names = await asyncio.to_thread(_checked_out, str(interaction.user.id))
    except (PyMongoError, RuntimeError):
        logging.exception("/checkedout failed")
        await interaction.response.send_message(BROKEN, ephemeral=True)
        return
    if names is None:
        await interaction.response.send_message(
            f"Your Discord account isn't linked to your {ORG_NAME} dashboard account yet. Link it on the dashboard home page, then try again.",
            ephemeral=True,
        )
        return
    if not names:
        await interaction.response.send_message("You don't have any hardware checked out.", ephemeral=True)
        return
    await interaction.response.send_message("Checked out to you:\n" + "\n".join(f"- {n}" for n in names), ephemeral=True)


def main() -> None:
    if not TOKEN:
        raise SystemExit("DISCORD_BOT_TOKEN is not set in the backend .env.")
    if not MONGODB_URI:
        raise SystemExit("MONGODB_URI is not set.")
    bot.run(TOKEN, log_handler=None)


if __name__ == "__main__":
    main()
