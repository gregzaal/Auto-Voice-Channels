import utils
import functions as func
from commands.base import Cmd

help_text = [
    [
        ("Usage:",
         "<PREFIX><COMMAND> `COMMAND` `ROLE ID`\n"
         "<PREFIX><COMMAND> `COMMAND` none"),
        ("Description:",
         "Restrict a particular command so that only users with a certain role can use it. "
         "Server admins will always be able to use any command regardless of their roles.\n\n"
         "Use \"<PREFIX>listroles <USER>\" to get a list of roles (and their IDs) that you have.\n"
         "Use \"<PREFIX>restrictions\" to see any existing restrictions that are in place.\n\n"),
        ("Examples:",
         " ·  `<PREFIX><COMMAND> name 615086491235909643`\n"
         "Only users that have the role with ID `615086491235909643` can use the `name` command.\n\n"
         " ·  `<PREFIX><COMMAND> lock 582927946004693000 615086491235909643`\n"
         "Only users that have **either** the role with ID `582927946004693000` or `615086491235909643` "
         "can use the `lock` command.\n\n"
         " ·  `<PREFIX><COMMAND> name none`\n"
         "Remove all restrictions for the `name` command."),
    ]
]


async def execute(ctx, params):
    params = [p for p in params if p]  # Remove any empty params
    guild = ctx['guild']
    settings = ctx['settings']
    author = ctx['message'].author

    cmd = params[0]

    from commands import commands
    if cmd not in commands:
        if 'dcnf' not in ctx['settings'] or ctx['settings']['dcnf'] is False:
            return False, ("`{}` is not a recognized command. Run '**{}help**' "
                           "to get a list of commands".format(cmd, ctx['print_prefix']))
        else:
            return False, "NO RESPONSE"

    if params[1].lower() == "none":
        if 'restrictions' in settings:
            try:
                del settings['restrictions'][cmd]
                utils.set_serv_settings(guild, settings)
                await func.server_log(
                    guild,
                    "✋ {} (`{}`) removed all restrictions for the `{}` command.".format(
                        func.user_hash(author), author.id, cmd
                    ), 2, settings)
                return True, "Done! Removed restrictions for the `{}` command.".format(cmd)
            except KeyError:
                return False, "There are no restrictions for the `{}` command.".format(cmd)
        else:
            return False, "There are no command restrictions."

    roles = []
    for r in params[1:]:
        try:
            role = guild.get_role(int(r))
            if role is None:
                raise ValueError
        except ValueError:
            return False, ("`{}` is not a valid role ID. "
                           "Use `{}listroles` to get a list of roles and their IDs.".format(r, ctx['print_prefix']))
        roles.append(role)

    if 'restrictions' not in settings:
        settings['restrictions'] = {}
    settings['restrictions'][cmd] = [r.id for r in roles]
    utils.set_serv_settings(guild, settings)

    roles_str = ', '.join("**{}**".format(r.name) for r in roles)
    await func.server_log(
        guild,
        "✋ {} (`{}`) set a restriction for the `{}` command: {}".format(
            func.user_hash(author), author.id, cmd, roles_str
        ), 2, settings)
    return True, ("Done! From now on only users with one of the following roles can use the `{}` command: {}"
                  "".format(cmd, roles_str))


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=2,
    gold_required=True,
    admin_required=True,
)
