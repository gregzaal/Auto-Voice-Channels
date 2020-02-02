from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND>"),
        ("Description:",
         "Remove the user limit in your channel. Also removes any limit that may have been "
         "inherited from the primary channel."),
    ]
]


async def execute(ctx, params):
    from commands import limit
    return await limit.command.execute(ctx, ['0'])


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=0,
    admin_required=False,
    voice_required=True,
    creator_only=True,
)
