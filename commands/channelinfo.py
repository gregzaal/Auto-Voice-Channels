import functions as func
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND>"),
        ("Description:",
         "A debugging command to get information about the channel you're in, such as the current bitrate, "
         "the games people in the channel are playing, and any custom bitrate settings for each user."),
    ]
]


async def execute(ctx, params):
    settings = ctx['settings']
    asip = settings['asip'] if 'asip' in settings else False
    c = ctx['voice_channel']

    template = settings['channel_name_template']
    for p, v in settings['auto_channels'].items():
        for s in v['secondaries']:
            if s == c.id:
                if 'template' in v:
                    template = v['template']
                break

    r = "Current channel name: **{}**\n".format(func.esc_md(c.name))
    r += "Channel name template: **{}**\n\n".format(func.esc_md(template))

    r += "Bitrate: **{0:.2f}** kbps\n".format(c.bitrate / 1000)
    r += "Custom bitrates:"
    any_bitrates = False
    for m in c.members:
        if 'custom_bitrates' not in settings:
            break
        if str(m.id) in settings['custom_bitrates']:
            any_bitrates = True
            r += "\n:white_small_square: {}: **{}**".format(
                func.esc_md(m.display_name), settings['custom_bitrates'][str(m.id)])
    if not any_bitrates:
        r += " **None**"
    r += "\n\n"

    r += "Game activity:"
    games = []
    for m in c.members:
        if m.activity and m.activity.name and not m.bot:
            act = m.activity
            games.append(act.name)
            r += "\n:white_small_square: {}: **{}**".format(
                func.esc_md(m.display_name),
                func.esc_md(act.name))
            r += '\t'
            if hasattr(act, 'state') and act.state:
                r += " {}".format(func.esc_md(act.state))
            if hasattr(act, 'details') and act.details:
                r += " ({})".format(func.esc_md(act.details))
            if hasattr(act, 'party') and act.party:
                r += " \tParty: "
                r += "" if 'id' not in act.party else "`{}` ".format(act.party['id'])
                r += "" if 'size' not in act.party else ('/'.join(str(v) for v in act.party['size']))
    if not games:
        r += " **None**"

    games = func.get_channel_games(c)
    for g in games:
        party = func.get_party_info(c, g, asip, default="None")
        if party:
            r += "\n\n**{}**\n".format(g)
            r += "Size: **{}**".format(party['size'])
            r += " *(includes {} user{} with no status)*\n".format(
                party['sneakies'], '' if party['sneakies'] == 1 else 's'
            ) if party['sneakies'] else "\n"
            r += "State: **{}**\n".format(party['state'])
            r += "Details: **{}**".format(party['details'])

    aliases = {}
    for g in games:
        if g in settings['aliases']:
            aliases[g] = settings['aliases'][g]
    if aliases:
        r += "\n\n"
        r += "Aliases for these games:"
        for g, a in aliases.items():
            r += "\n:white_small_square: {}: **{}**".format(
                func.esc_md(g),
                func.esc_md(a))

    return True, r


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=0,
    admin_required=False,
    voice_required=True,
)
