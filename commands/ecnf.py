import utils
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND>"),
        ("Description:",
         "Enable the error message when you type a command I don't recognize.\n\n"
         "Use `<PREFIX>dcnf` to disable the error messages instead."),
    ]
]


async def execute(ctx, params):
    ctx['settings']['dcnf'] = False
    utils.set_serv_settings(ctx['guild'], ctx['settings'])
    return True, "From now on I'll tell you if you typed a command incorrectly."


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=0,
    admin_required=True,
)
