import functions as func
from commands.base import Cmd

try:
    import patreon_info
except ImportError:
    patreon_info = None

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND>"),
        ("Description:",
         "Authenticate yourself as a patron and set this server as your primary server "
         "where your rewards will be unlocked."),
    ]
]


async def execute(ctx, params):
    return await func.power_overwhelming(ctx, ctx['guild'])


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=0,
    admin_required=True,
)
