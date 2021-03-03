import functions as func
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND>"),
        ("Description:",
         "Will take all users in the 'Tavern' channel and move them from that voice channel back into the one's they were\n"
         "previously in before the merge command was used"),
    ]
]


async def execute(ctx, params):
    channel = ctx['channel']
    guild = ctx['guild']
    client = ctx['client']
    
    #print(CategoryID)

    await func.split_channels(guild, channel, client)

    return True, ("Successfully split channel into groups")




command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=0,
    admin_required=False,
    voice_required=False,
)
