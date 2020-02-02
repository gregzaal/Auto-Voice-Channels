import utils
import functions as func
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND> `@USER`"),
        ("Description:",
         "Transfer ownership of your channel to someone else in the channel, allowing them to use commands that "
         "require them to be the creator (e.g. `private`, `limit`, `name`...)."),
        ("Examples:",
         "```<PREFIX><COMMAND> @pixaal```"),
    ]
]


async def execute(ctx, params):
    name = ' '.join(params).strip()
    guild = ctx['guild']
    author = ctx['message'].author
    vc = ctx['voice_channel']

    user = utils.get_user_in_channel(name, vc)

    if not user:
        return False, "Can't find any user in your channel with the name \"{}\".".format(name)
    if user.id == ctx['creator_id']:
        if user == author:
            return False, "You're already the creator."
        else:
            return False, "{} is already the creator.".format(func.user_hash(user))

    result = await func.set_creator(guild, vc.id, user)
    return result, None


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=1,
    admin_required=False,
    voice_required=True,
    creator_only=True,
)
