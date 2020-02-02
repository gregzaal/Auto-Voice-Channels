import discord
import traceback
import functions as func
from commands.base import Cmd
from utils import log

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND>"),
        ("Description:",
         "List all of the aliases for game names in this server."),
    ]
]


async def execute(ctx, params):
    settings = ctx['settings']
    channel = ctx['channel']
    author = ctx['message'].author

    if not settings['aliases']:
        return True, "You haven't set any aliases yet."

    e = discord.Embed(color=discord.Color.from_rgb(205, 220, 57))
    e.title = "This server has the following aliases:"
    e.set_footer(
        text="Use \"{0}removealias ORIGINAL NAME\" to delete an alias, "
        "or \"{0}alias ORIGINAL NAME >> NEW NAME\" to create or replace one.".format(ctx['print_prefix']))

    keys = sorted(settings['aliases'].keys(), key=lambda x: x.lower())
    for a in keys:
        av = settings['aliases'][a]
        e.add_field(name=a, value=av, inline=True)
    try:
        await channel.send(embed=e)
    except discord.errors.Forbidden:
        log("Forbidden to echo", channel.guild)
        await func.dm_user(
            author,
            "I don't have permission to send messages in the "
            "`#{}` channel of **{}**.".format(channel.name, channel.guild.name)
        )
        return False, "NO RESPONSE"
    except Exception:
        log("Failed to echo", channel.guild)
        print(traceback.format_exc())
        return False, "NO RESPONSE"

    return True, "NO RESPONSE"


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=0,
    admin_required=True,
)
