import discord
import utils
import functions as func
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND> `NEW NAME`"),
        ("Description:",
         "Change the name of the temporary private text channels made for each voice chat if `textchannels` is enabled."
         "\nDefault is `voice context`."),
        ("Example:", "<PREFIX><COMMAND> typing/tts/bot commands"),
    ]
]


async def execute(ctx, params):
    params_str = ' '.join(params)
    guild = ctx['guild']
    settings = ctx['settings']
    author = ctx['message'].author
    new_word = params_str.replace('\n', ' ')  # Can't have newlines in channel name.
    new_word = utils.strip_quotes(new_word)
    previous_word = ("voice context" if 'text_channel_name' not in settings else
                     func.esc_md(settings['text_channel_name']))
    if not new_word:
        return False, ("You need to define a new name, e.g. `{}textchannelname links` to make "
                       "**links** shown instead of **{}**.".format(ctx['print_prefix'], previous_word))
    settings['text_channel_name'] = new_word
    utils.set_serv_settings(guild, settings)
    e_new_word = func.esc_md(new_word)
    await func.server_log(
        guild,
        "💬 {} (`{}`) set the server's \"voice context\" name to **{}**".format(
            func.user_hash(author), author.id, e_new_word
        ), 2, settings)

    for p, pv in settings['auto_channels'].items():
        for s, sv in pv['secondaries'].items():
            if 'tc' in sv:
                tc = guild.get_channel(sv['tc'])
                try:
                    await tc.edit(name=utils.nice_cname(new_word))
                except discord.errors.Forbidden:
                    pass

    return True, ("Done! From now on I'll use **{}** instead of **{}**.".format(e_new_word, previous_word))


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=1,
    gold_required=True,
    admin_required=True,
)
