import discord
from functions import dm_user
from utils import log
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND>"),
        ("Description:",
         "Support the developers of this bot on Patreon (https://www.patreon.com/pixaal)"),
    ]
]


async def execute(ctx, params):
    channel = ctx['channel']
    t = "💗 Support us on Patreon"
    l = "https://www.patreon.com/pixaal"
    can_embed = channel.permissions_for(ctx['guild'].me).embed_links
    if can_embed:
        try:
            await channel.send(embed=discord.Embed(
                description="**[{}]({})**".format(t, l)
            ))
        except discord.errors.Forbidden:
            log("Forbidden to echo", channel.guild)
            await dm_user(
                ctx['message'].author,
                "I don't have permission to send messages in the "
                "`#{}` channel of **{}**.".format(channel.name, channel.guild.name)
            )
            return False, "NO RESPONSE"
        return True, "NO RESPONSE"
    else:
        return True, ("{}\n<{}>".format(t, l))

command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=0,
    admin_required=False,
)
