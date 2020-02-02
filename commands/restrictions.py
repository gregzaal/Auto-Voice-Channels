from commands.base import Cmd

help_text = [
    [
        ("Usage:",
         "<PREFIX><COMMAND>\n"
         "<PREFIX><COMMAND> `COMMAND`"),
        ("Description:",
         "Show any role retrictions set for all or a particular command using `<PREFIX>restrict`."),
        ("Examples:",
         "`<PREFIX><COMMAND>`\n"
         "`<PREFIX><COMMAND> name`\n"
         "`<PREFIX><COMMAND> lock`"),
    ]
]


async def execute(ctx, params):
    cmd = ' '.join(params).strip()
    guild = ctx['guild']
    settings = ctx['settings']

    if 'restrictions' not in settings or not settings['restrictions']:
        return True, "There are currently no restrictions for any commands."

    if cmd:
        from commands import commands
        if cmd not in commands:
            if 'dcnf' not in ctx['settings'] or ctx['settings']['dcnf'] is False:
                return False, ("`{}` is not a recognized command. Run '**{}help**' "
                               "to get a list of commands".format(cmd, ctx['print_prefix']))
            else:
                return False, "NO RESPONSE"

    restrictions = {}
    for r, rv in settings['restrictions'].items():
        if not cmd or r == cmd:
            restrictions[r] = rv

    if not restrictions:
        if not cmd:
            return True, "There are currently no restrictions for any commands."
        return True, "There are currently no restrictions for the `{}` command.".format(cmd)

    s = "**Restrictions:**"
    for r, rv in restrictions.items():
        roles = []
        for rid in rv:
            role = guild.get_role(rid)
            roles.append("{} (`{}`)".format(role.name, role.id) if role else "⚠ REMOVED ROLE")
        s += "\n`{}`: {}".format(r, ', '.join(roles))
    return True, s


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=0,
    gold_required=True,
    admin_required=True,
)
