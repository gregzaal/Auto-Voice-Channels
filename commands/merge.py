import functions as func
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND>"),
        ("Description:",
         "When used in a text channel belonging to a group, will merge in channels made using the 'New Session' channel\n"
         "and place them into that groups 'Tavern' channel"),
    ]
]


async def execute(ctx, params):
    channel = ctx['channel']
    guild = ctx['guild']
    CategoryID = channel.category_id
    
    #print(CategoryID)

    await func.merge_channels(guild, channel)

    return True, ("Successfully merged channels")




command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=0,
    admin_required=False,
    voice_required=False,
)
