import utils
import functions as func
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND> `name`"),
        ("Description:",
         "Set a nickname for yourself that will be used only in voice channel names, "
         "if `@@creator@@` is in the template. Does not change your actual nick/name.\n\n"
         "Use `<PREFIX><COMMAND> reset` to remove your nick and always use your actual name instead."),
        ("Examples:",
         "<PREFIX><COMMAND> pix\n"
         "<PREFIX><COMMAND> Big G\n"
         "<PREFIX><COMMAND> reset"),
    ]
]


async def execute(ctx, params):
    params_str = ' '.join(params)
    guild = ctx['guild']
    settings = ctx['settings']
    author = ctx['message'].author
    nick = utils.strip_quotes(params_str)

    if nick.lower() == 'reset':
        try:
            del settings['custom_nicks'][str(author.id)]
            utils.set_serv_settings(guild, settings)
        except KeyError:
            return False, "You haven't set a custom nickname."
        return True, "Your custom nickname has been removed."

    if 'custom_nicks' not in settings:
        settings['custom_nicks'] = {}
    settings['custom_nicks'][str(author.id)] = nick
    utils.set_serv_settings(guild, settings)

    await func.server_log(
        guild,
        "🙋 {} (`{}`) set their custom nick to {}".format(
            func.user_hash(author), author.id, nick
        ), 2, settings)
    return True, ("Done! Channels that show the creator's name will now call you **{}** instead of **{}**.".format(
        nick, author.display_name))


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=1,
    gold_required=True,
    admin_required=False,
)
