import discord
import utils
from commands.base import Cmd

help_text = [
    [
        ("Usage:",
         "<PREFIX><COMMAND> `ROLE ID`\n"
         "<PREFIX><COMMAND> @Mention Role\n"
         "<PREFIX><COMMAND> none"),
        ("Description:",
         "Show the text channels that are made for each voice channel to users that have the specified role, "
         "e.g. moderators, or `@everyone` if you want them to be public.\n\n"
         "Only one role can be specified, using this command multiple times will overwrite the previous setting.\n\n"
         "Note that text channels will still be deleted once everyone leaves the associated voice chat."),
        ("Examples:",
         "<PREFIX><COMMAND> 615086491235909643\n"
         "<PREFIX><COMMAND> `@everyone`\n"
         "<PREFIX><COMMAND> `@Moderators`\n"
         "<PREFIX><COMMAND> none"),
    ]
]


async def execute(ctx, params):
    params_str = ' '.join(params)
    guild = ctx['guild']
    settings = ctx['settings']
    param = utils.strip_quotes(params_str)

    if param.lower() == 'none':
        try:
            del settings['stct']
            utils.set_serv_settings(guild, settings)
            return (True, "From now on, new text channels will only be visible to the channel's occupants. "
                    "Existing channels will not be affected.")
        except KeyError:
            return False, "Text channels are already invisible to everyone but the channel's occupants."

    role = None
    try:
        param = int(param)
        role = guild.get_role(param)
    except ValueError:
        if param == "@everyone":
            role = guild.default_role
        else:
            for r in guild.roles:
                if r.mention == param:
                    role = r
                    break

    if role is None:
        return False, "I can't find that role. You need to specify either the role ID, or `@mention` it."

    settings['stct'] = role.id
    utils.set_serv_settings(guild, settings)
    return (True, "From now on, new text channels can be seen by users with the \"{}\" role. "
            "Existing channels will not be affected.".format(discord.utils.escape_mentions(role.name)))


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=1,
    gold_required=True,
    admin_required=True,
)
