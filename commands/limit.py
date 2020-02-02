import utils
import functions as func
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND>\n"
                   "<PREFIX><COMMAND> `N`"),
        ("Description:",
         "Use when already in a channel - Limit the number of users allowed in your channel to either the current "
         "number of users, or the specified number.\n\n"
         "Use *<PREFIX>un<COMMAND>* to remove the limit."),
        ("Example:", "<PREFIX><COMMAND> 4"),
    ]
]


async def execute(ctx, params):
    params_str = ' '.join(params)
    guild = ctx['guild']
    settings = ctx['settings']
    limit = utils.strip_quotes(params_str)
    author = ctx['message'].author
    vc = ctx['voice_channel']

    if limit:
        try:
            limit = abs(int(limit))
        except ValueError:
            return False, "`{}` is not a number.".format(limit)
    else:
        limit = len(vc.members)

    if limit > 99:
        return False, "The user limit cannot be higher than 99."

    await vc.edit(user_limit=limit)
    if limit != 0:
        log_msg = "👪 {} (`{}`) set the user limit of \"**{}**\" (`{}`) to {}".format(
            func.user_hash(author), author.id, func.esc_md(vc.name), vc.id, limit
        )
    else:
        log_msg = "👨‍👩‍👧‍👦 {} (`{}`) removed the user limit of \"**{}**\" (`{}`)".format(
            func.user_hash(author), author.id, func.esc_md(vc.name), vc.id
        )
    await func.server_log(guild, log_msg, 2, settings)
    return True, None


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=0,
    admin_required=False,
    voice_required=True,
    creator_only=True,
)
