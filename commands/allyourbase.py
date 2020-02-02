import utils
import functions as func
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND>"),
        ("Description:",
         "Assume ownership of the channel you're in.\n"
         "As an admin you can already use all creator-only commands even if you're not actually the creator, "
         "but this will now display you as the creator to everyone else.\n\n"
         "Use `<PREFIX>transfer @USER` if you want to assign someone else as the creator."),
    ]
]


async def execute(ctx, params):
    guild = ctx['guild']
    author = ctx['message'].author
    vc = ctx['voice_channel']

    creator_id = utils.get_creator_id(ctx['settings'], vc)

    if author.id == creator_id:
        return False, "You're already the creator."

    result = await func.set_creator(guild, vc.id, author)
    return result, None


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=0,
    admin_required=True,
    voice_required=True,
)
