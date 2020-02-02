import utils
import functions as func
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND> `N`"),
        ("Description:",
         "Set the default user limit for channels created by a particular primary channel, "
         "without editing the primary channel itself.\n\n"
         "First join a voice channel, then run the command to set the limit for that channel and all other secondary "
         "channels created by the same primary (\"+ New Session\") channel.\n\n"
         "Doesn't affect any existing sibling channels, only future channels. "
         "Remove the limit by running \"<PREFIX><COMMAND> 0\".\n"
         "Users can still run \"<PREFIX>limit\" or \"<PREFIX>unlimit\" to temporarily change/remove the limit of their "
         "own channel."),
        ("Example:", "<PREFIX><COMMAND> 4"),
    ]
]


async def execute(ctx, params):
    params_str = ' '.join(params)
    guild = ctx['guild']
    limit = utils.strip_quotes(params_str)
    try:
        limit = int(limit)
    except ValueError:
        if limit:
            return False, "`{}` is not a number.".format(limit)
        else:
            return False, ("You need to specify a number to set the limit to. "
                           "E.g. '{}defaultlimit 4'".format(ctx['print_prefix']))
    await func.set_default_limit(guild, ctx['voice_channel'], limit)
    if int(limit) != 0:
        return True, ("Done! From now on, voice channels like the one you're in now will be limited to "
                      "{0} users. You can reset this by running `{1}defaultlimit 0`.\n"
                      "If you want to set the limit of *only* your channel, "
                      "use `{1}limit` instead.".format(limit, ctx['print_prefix']))
    else:
        return True, ("Done! From now on, voice channels like the one you're in now will have no user limit.")


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=1,
    admin_required=True,
    voice_required=True,
)
