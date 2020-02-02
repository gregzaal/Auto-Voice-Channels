import utils
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND> `GAME NAME` >> `ALIAS`"),
        ("Description:",
         "Change the displayed name for a certain game if, for example it's too long to fit in the channel sidebar.\n\n"
         "**Warning:** Aliases are case sensitive. Be sure to match the name of the game exactly, "
         "or it will not be replaced.\n\n"
         "Use `<PREFIX>aliases` to list all existing aliases, and `<PREFIX>removealias` to delete one."),
        ("Example:", "<PREFIX><COMMAND> The Elder Scrolls V: Skyrim >> Skyrim"),
    ]
]


async def execute(ctx, params):
    params_str = ' '.join(params)
    guild = ctx['guild']
    settings = ctx['settings']
    gsplit = params_str.split('>>')
    if len(gsplit) != 2 or not gsplit[0] or not gsplit[-1]:
        return False, ("Incorrect syntax for alias command. Should be: `{}alias [Actual game name] >> "
                       "[New name]` (without square brackets).".format(ctx['print_prefix']))
    else:
        gname = utils.strip_quotes(gsplit[0])
        aname = utils.strip_quotes(gsplit[1])
        if gname in settings['aliases']:
            oaname = settings['aliases'][gname]
            response = "'{}' already has an alias ('{}'), it will be replaced with '{}'.".format(gname, oaname, aname)
        else:
            response = "'{}' will now be shown as '{}'.".format(gname, aname)
        settings['aliases'][gname] = aname
        utils.set_serv_settings(guild, settings)
        return True, response


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=1,
    admin_required=True,
)
