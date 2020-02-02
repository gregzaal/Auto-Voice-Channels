import utils
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND>"),
        ("Description:",
         "Disable the error message when you type a command I don't recognise.\n\n"
         "This is not recommended, but can be used if you want to have multiple bots using the same prefix.\n\n"
         "Use `<PREFIX>ecnf` to enable the error messages again."),
    ]
]


async def execute(ctx, params):
    ctx['settings']['dcnf'] = True
    utils.set_serv_settings(ctx['guild'], ctx['settings'])
    return True, "OK, I'll no longer tell you if you typed a command incorrectly."


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=0,
    admin_required=True,
)
