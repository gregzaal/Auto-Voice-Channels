import utils
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND>"),
        ("Description:",
         "Toggle whether custom channel names set with the `<PREFIX>name` or `<PREFIX>rename` commands have to be "
         "unique or not.\n"
         "**OFF** by default. When turned on, users will be unable to rename their channel if there is "
         "another voice channel with the same custom name anywhere in the server.\n\n"
         "The check is only done once when renaming the channel, and compares only the name/template itself, "
         "not the result of the template being evaluated. "
         "E.g. `We love @@game_name@@` will be seen as identical to another channel with the same template, "
         "even if the game they are playing is different."),
    ]
]


async def execute(ctx, params):
    guild = ctx['guild']
    settings = ctx['settings']
    settings['uniquenames'] = not settings['uniquenames'] if 'uniquenames' in settings else True
    utils.set_serv_settings(guild, settings)
    return True, ("Done. From now on, custom channel names {}. Run this command again to swap back.".format(
        "will **have to be unique**" if settings['uniquenames'] else "**no longer** have to be unique"
    ))


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=0,
    gold_required=True,
    admin_required=True,
)
