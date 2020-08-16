import functions as func
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND>"),
        ("Description:",
         "Toggle whether new channels are placed above (default) or below the primary one.\n"
         "First join a voice channel and then run the command to toggle the position of future channels "
         "created by the same primary (\"+ New Session\") channel.\n"
         "Does not affect existing channels, wait for those to become empty and get deleted, or move them manually."),
    ]
]


async def execute(ctx, params):
    channel = ctx['channel']
    guild = ctx['guild']
    
    #print(CategoryID)

    await func.reset_group(guild, channel)

    return True, ("Successfully merged channels")




command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=0,
    admin_required=False,
    voice_required=False,
)
