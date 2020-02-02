import functions as func
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND> `NEW NAME`"),
        ("Description:",
         "Directly change the name of the channel you're in. "
         "Supports all variables from the `template` command (use `<PREFIX>help template` to get a list).\n\n"
         "Use `<PREFIX><COMMAND> reset` to remove your name override and revert to the original template."),
        ("Examples:",
         "<PREFIX><COMMAND> Bob's bustling barbeque bash\n"
         "<PREFIX><COMMAND> Karen loves @@game_name@@\n"
         "<PREFIX><COMMAND> reset"),
    ]
]


async def execute(ctx, params):
    params_str = ctx['clean_paramstr']
    guild = ctx['guild']
    author = ctx['message'].author

    new_name = params_str.replace('\n', ' ')  # Can't have newlines in channel name.
    new_name = new_name.strip()
    if new_name:
        return await func.custom_name(guild, ctx['voice_channel'], author, new_name)
    else:
        return False, ("You need to specify a new name for this channel, e.g. '{0}name <new name>'.\n"
                       "Run '{0}help template' for a full list of variables you can use like "
                       "`@@game_name@@`, `@@creator@@` and `@@num_others@@`.".format(ctx['print_prefix']))


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=1,
    gold_required=True,
    admin_required=False,
    voice_required=True,
    creator_only=True,
)
