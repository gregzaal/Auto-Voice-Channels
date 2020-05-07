import cfg
import discord
from functions import dm_user
from utils import log
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND>"),
        ("Description:",
         "Test if the bot is alive, and see the delay between your commands and my response.\n"
         "`0.1s` to `1s` response time is normal.\n"
         "Higher than `1s` indicates I'm struggling to keep up, "
         "but you should try again to see if the delay was only temporary.\n"
         "Higher than `5s` indicates something is probably very, *very* wrong.\n"
         "No response means you either typed the command incorrectly, I don't have permission to read and respond "
         "to messages in that channel, or I'm dead. Please don't let me die I don't want to die."),
    ]
]


async def execute(ctx, params):
    try:
        r = await ctx['channel'].send("One moment...")
    except discord.errors.Forbidden:
        log("Forbidden to echo", ctx['channel'].guild)
        await dm_user(
            ctx['message'].author,
            "I don't have permission to send messages in the "
            "`#{}` channel of **{}**.".format(ctx['channel'].name, ctx['channel'].guild.name)
        )
        return False, "NO RESPONSE"
    t1 = ctx['message'].created_at
    t2 = r.created_at
    embed = discord.Embed(color=discord.Color.from_rgb(205, 220, 57))
    rc = (t2 - t1).total_seconds()
    e = '😭' if rc > 5 else ('😨' if rc > 1 else '👌')
    embed.add_field(name="Reaction time:", value="{0:.3f}s {1}\n".format(rc, e))
    rc = ctx['client'].latency
    e = '😭' if rc > 5 else ('😨' if rc > 1 else '👌')
    embed.add_field(name="Discord latency:", value="{0:.3f}s {1}\n".format(rc, e))
    guild = ctx['guild']
    embed.add_field(name="Shard:", value=guild.shard_id)
    embed.add_field(name="Guild region:", value=guild.region)
    embed.add_field(name="Bot region:", value=cfg.SERVER_LOCATION)
    await r.edit(content="Pong!", embed=embed)
    return True, "NO RESPONSE"


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=0,
    admin_required=False,
)
