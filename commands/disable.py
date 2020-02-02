import utils
from functions import log
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND>"),
        ("Description:",
         "Turn me off in this server. You can still use all my commands, "
         "but I won't create any new voice channels for anyone."),
    ]
]


async def execute(ctx, params):
    settings = ctx['settings']
    guild = ctx['guild']
    if not settings['enabled']:
        return False, "Already disabled. Use '{}enable' to turn on.".format(ctx['print_prefix'])
    else:
        log("Disabling", guild)
        settings['enabled'] = False
        utils.set_serv_settings(guild, settings)
        return True, "Disabling auto voice channels. Turn on again with '{}enable'.".format(ctx['print_prefix'])
    return


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=0,
    admin_required=True,
)
