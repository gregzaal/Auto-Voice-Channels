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
    r = await func.power_overwhelming(ctx, ctx['guild'])
    if params and len(r) > 1:
        response = r[1] if r[1] != "NO RESPONSE" else ""
        if r[0] is True:
            response += ("\nNote: If you want to authenticate more than one server, "
                         "you need to DM me `power-overwhelming SERVER_ID SERVER_ID SERVER_ID...`")
            return (r[0], response)
    return r


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=0,
    admin_required=True,
)
