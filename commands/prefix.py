import cfg
import utils
import functions as func
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND> `NEW PREFIX`"),
        ("Description:",
         "Change the default prefix for commands. The default is `vc/`.\n"
         "The prefix is **not** case sensitive, to cater to mobile users as well."
         "Be careful of setting the prefix to one that another bot is already using, "
         "both bots will likely respond to the same command.\n"
         "Mentioning me instead (i.e. using \"@\" + my name as the prefix) will always work."),
        ("Example:", "`<PREFIX><COMMAND> avc-` to make `avc-` the new command prefix."),
    ]
]


async def execute(ctx, params):
    params_str = ' '.join(params)
    guild = ctx['guild']
    settings = ctx['settings']
    author = ctx['message'].author
    new_prefix = utils.strip_quotes(params_str)
    if not new_prefix:
        return False, ("You need to define a new prefix, e.g. `{}prefix avc-` to make "
                       "`avc-` the new prefix.".format(ctx['print_prefix']))
    disallowed_characters = ['\n', '\t', '`']
    for c in disallowed_characters:
        if c in new_prefix:
            return False, "Your prefix can't contain **new lines**, **tab characters**, or **\`**."
    response = ("Done! My prefix in your server is now `{0}`. Try running `{0}ping` to test it out.\n"
                "Remember, you can always mention me instead of using my prefix (e.g: **{1} ping**)"
                ".".format(new_prefix, ctx['message'].guild.me.mention))
    if len(new_prefix) == 1:
        response += ("\n\n:information_source: Note: If you use the **same prefix as another bot**, "
                     "you should also run `{}dcnf` to prevent error messages when using that bot's commands."
                     "".format(new_prefix))
    cfg.PREFIXES[guild.id] = new_prefix
    settings['prefix'] = new_prefix
    utils.set_serv_settings(guild, settings)
    await func.server_log(
        guild,
        "💬 {} (`{}`) set the server's prefix to `{}`".format(
            func.user_hash(author), author.id, new_prefix
        ), 1, settings)
    return True, response


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=1,
    admin_required=True,
)
