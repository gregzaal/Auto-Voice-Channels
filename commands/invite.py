import cfg
import discord
from functions import dm_user
from utils import log
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND>"),
        ("Description:",
         "Get my invite link to invite me to a different server."),
    ]
]


async def execute(ctx, params):
    channel = ctx['channel']
    t = "📫 Invite me to another server!"
    bot_id = ctx['client'].user.id
    if cfg.SAPPHIRE_ID is not None:
        bot_id = 479393422705426432
    beta_id = 675405085752164372
    invite_id = bot_id if bot_id != beta_id else beta_id
    l = cfg.INVITE_LINK.replace('@@CID@@', str(invite_id))
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
