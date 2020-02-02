import utils
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND> `GAME NAME`"),
        ("Description:",
         "Delete the alias for a particular game. You can specify either the original name, or the alias. \n\n"
         "If multiple games have the same alias, they will all be removed."),
        ("Examples:",
         "<PREFIX><COMMAND> The Elder Scrolls V: Skyrim"
         "<PREFIX><COMMAND> Skyrim"),
    ]
]


async def execute(ctx, params):
    alias = ' '.join(params).strip()
    guild = ctx['guild']
    settings = ctx['settings']

    if not settings['aliases']:
        return True, "You haven't set any aliases yet."

    keys_to_delete = []
    for a, av in settings['aliases'].items():
        if (alias == a or alias == av) and a not in keys_to_delete:
            keys_to_delete.append(a)

    if keys_to_delete:
        for k in keys_to_delete:
            del settings['aliases'][k]
        utils.set_serv_settings(guild, settings)
        return True, ("Removed {} alias{}".format(
            len(keys_to_delete), "es" if len(keys_to_delete) != 1 else ""))
    else:
        return False, (
            "There is no alias for the game `{}` - please be exact, this operation is case-sensitive. "
            "Use `{}aliases` to get a list of the aliases in this server.".format(
                alias, ctx['print_prefix']))


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=1,
    admin_required=True,
)
