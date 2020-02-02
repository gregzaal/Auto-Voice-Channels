import utils
import functions as func
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND> `NEW WORD`"),
        ("Description:",
         "If you use `@@game_name@@` in your channel name templates, when no game is detected or "
         "there are multiple games being played, the word \"General\" is used instead of any game name.\n"
         "Use this command to change \"General\" to something else, like \"Party\", \"Lounge\", etc."),
        ("Example:", "<PREFIX><COMMAND> Lounge"),
    ]
]


async def execute(ctx, params):
    params_str = ' '.join(params)
    guild = ctx['guild']
    settings = ctx['settings']
    author = ctx['message'].author
    new_word = params_str.replace('\n', ' ')  # Can't have newlines in channel name.
    new_word = utils.strip_quotes(new_word)
    previous_word = "General" if 'general' not in settings else func.esc_md(settings['general'])
    if not new_word:
        return False, ("You need to define a new word, e.g. `{}general Lounge` to make "
                       "**Lounge** shown instead of **{}**.".format(ctx['print_prefix'], previous_word))
    settings['general'] = new_word
    utils.set_serv_settings(guild, settings)
    e_new_word = func.esc_md(new_word)
    await func.server_log(
        guild,
        "🎮 {} (`{}`) set the server's \"General\" word to **{}**".format(
            func.user_hash(author), author.id, e_new_word
        ), 2, settings)
    return True, ("Done! From now on I'll use **{}** instead of **{}**.".format(e_new_word, previous_word))


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=1,
    gold_required=True,
    admin_required=True,
)
