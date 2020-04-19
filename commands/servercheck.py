import cfg
import discord
import functions as func
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND>"),
        ("Description:",
         "Get information about this server, such as the voice channels I know about and the Patreon status."),
    ]
]


def permission_checks(channel, me):
    r = ""
    perms = me.permissions_in(channel)
    if not perms.manage_channels:
        r += " `❌ Manage Channels`"
    if not perms.read_messages:
        r += " `❌ Read Text Channels & See Voice Channels`"
    if not perms.connect:
        r += " `❌ Connect`"
    if not perms.move_members:
        r += " `❌ Move members`"

    if r:
        r = "\t Permission issues:" + r
    return r


async def execute(ctx, params):
    guild = ctx['guild']
    settings = ctx['settings']
    r = "Name: **{}** \tID: `{}`\n".format(func.esc_md(guild.name), guild.id)
    members = [m for m in guild.members if not m.bot]
    num_members = len(members)
    percent_members_online = len([m for m in members if m.status != discord.Status.offline]) / num_members * 100
    r += "**{}** non-bot members, {}% currently online\n".format(num_members, round(percent_members_online))
    r += "Gold features active: **{}**\n".format("Yes" if func.is_gold(guild) else "No")
    r += "Sapphire features active: {}\n".format(
        ("**Yes** +private bot" if cfg.SAPPHIRE_ID is not None else "**Yes**") if func.is_sapphire(guild) else "**No**"
    )

    r += "\n**Known Channels:**\n"
    for p in settings['auto_channels']:
        pc = guild.get_channel(p)
        if pc:
            r += "{} (`{}`)".format(func.esc_md(pc.name), pc.id)
            if pc.category:
                r += " in category \"{}\"".format(func.esc_md(pc.category.name))
            r += permission_checks(pc, guild.me)
            secondaries = settings['auto_channels'][p]['secondaries']
            r += "\t {} sub-channel{}".format(len(secondaries), "s" if len(secondaries) != 1 else "")
            r += "\n"
            for s, v in secondaries.items():
                sc = guild.get_channel(s)
                scc = guild.get_member(v['creator'])
                if sc:
                    r += "\t ⮡ \t\"{}\" (`{}`)\t Created by: \"{}\" (\"{}\", `{}`){}\n".format(
                        func.esc_md(sc.name), sc.id,
                        func.esc_md(scc.display_name), func.user_hash(scc), scc.id,
                        permission_checks(sc, guild.me)
                    )
    r = r.replace('➕', '＋')  # Make the default plus sign more visible
    return True, r


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=0,
    admin_required=True,
)
