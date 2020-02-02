import functions as func
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND> `CHANNEL_ID` `NEW NAME`"),
        ("Description:",
         "Change the name of the specified channel without having to be in that channel yourself. "
         "Supports all variables from the `template` command (use `<PREFIX>help template` to get a list).\n\n"
         "Use `<PREFIX><COMMAND> ID reset` to remove your name override and revert to the original template.\n\n"
         "If you don't know how to find the channel ID, enable Developer Mode in your User Settings in discord, "
         "then right click the channel and select *Copy ID*."),
        ("Examples:",
         "<PREFIX><COMMAND> 603174408957198347 Bob's bustling barbeque bash\n"
         "<PREFIX><COMMAND> 603174408957198347 Karen loves @@game_name@@\n"
         "<PREFIX><COMMAND> 603174408957198347 reset"),
    ]
]


async def execute(ctx, params):
    params_str = ctx['clean_paramstr']
    guild = ctx['guild']
    settings = ctx['settings']
    author = ctx['message'].author

    new_name = params_str.replace('\n', ' ')  # Can't have newlines in channel name.
    new_name = new_name.strip()

    secondaries = func.get_secondaries(guild, settings)

    first_word = new_name.split(' ')[0]
    try:
        cid = int(first_word)
    except ValueError:
        return False, ("`{}` is not a valid channel ID. Please run `{}help rename` "
                       "to learn how to use this command.".format(first_word, ctx['print_prefix']))

    target_c = guild.get_channel(cid)
    if target_c is None:
        return False, "I can't find any channel with the ID `{}`.".format(cid)
    if cid not in secondaries:
        return False, "Sorry, that's not one of my channels."

    new_name = new_name[len(str(cid)):].strip()

    if new_name:
        return await func.custom_name(guild, target_c, author, new_name)
    else:
        return False, ("You need to specify a new name for the channel, e.g. '{0}rename {1} <new name>'.\n"
                       "Run '{0}help template' for a full list of variables you can use like "
                       "`@@game_name@@`, `@@creator@@` and `@@num_others@@`.".format(ctx['print_prefix'], cid))


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=2,
    gold_required=True,
    admin_required=True,
)
