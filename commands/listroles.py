import utils
from functions import echo
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND>\n"
                   "<PREFIX><COMMAND> `@USER`"),
        ("Description:",
         "List all of the roles (and their IDs) in the server, or all the roles that a particular user has."),
        ("Examples:",
         "<PREFIX><COMMAND>\n"
         "<PREFIX><COMMAND> @pixaal"),
    ]
]


async def execute(ctx, params):
    params_str = ' '.join(params)
    guild = ctx['guild']
    username = utils.strip_quotes(params_str)
    if username:
        # Show roles of particular user if param is provided
        found_user = False
        for m in guild.members:
            if m.name == username or m.mention == username:
                roles = m.roles
                found_user = True
                break
        if not found_user:
            return False, "There is no user named \"{}\"".format(username)
    else:
        # If no param is provided, show all roles in server
        roles = guild.roles

    l = ["```{:^16}".format("ID") + " Creation Date    Name```"]
    roles = sorted(roles, key=lambda x: x.created_at)
    for r in roles:
        if r.name != "@everyone":
            l.append("`{0}`  `{1}`  {2}".format(str(r.id),
                                                r.created_at.strftime("%Y/%m/%d"),
                                                r.name))
    for c in utils.chunks(l, 10):
        await echo('\n'.join(c), ctx['channel'], ctx['message'].author)

    return True, "NO RESPONSE"


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=0,
    admin_required=True,
)
