import functions as func
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND>"),
        ("Description:",
         "Once you have completed using the group, run this command so that the voice channels being preserved by the.\n"
         "merge command can be automatically deleted again"),
    ]
]


async def execute(ctx, params):
    channel = ctx['channel']
    guild = ctx['guild']
    
    #print(CategoryID)

    await func.reset_group(guild, channel)

    return True, ("Successfully reset group")




command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=0,
    admin_required=False,
    voice_required=False,
)
