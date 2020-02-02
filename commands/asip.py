import utils
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND>"),
        ("Description:", "Short for \"Assume Sneaky is Playing\" - This affects the behavior of the "
         "`@@num_playing@@` template variable.\n\n"
         "`@@num_playing@@` is determined firstly by any party information found in Discord Rich Presence, "
         "however most games do not use Rich Presence so it has to take a guess based on the activity status of "
         "members in the voice channel.\n"
         "However some users choose not to display their game activity as a status message for privacy reasons, or "
         "set themselves to \"Invisible\". Because of this, `@@num_playing@@` might be inaccurate.\n\n"
         "This command toggles whether or not channel members without any activity status are assumed to be "
         "playing the most popular game in the channel.\n\n"
         "Use this command if your server plays primarily only one or a handful of games, and you use "
         "`@@num_playing@@` in your channel template.\n\n"
         "**OFF** by default."),
    ]
]


async def execute(ctx, params):
    guild = ctx['guild']
    settings = ctx['settings']
    asip = not settings['asip'] if 'asip' in settings else True
    settings['asip'] = asip
    utils.set_serv_settings(guild, settings)
    if asip:
        r = ("OK, from now on I'll assume channel members without any activity/status are also playing the same thing "
             "as most other members in the channel.")
    else:
        r = ("ASIP is now **OFF** :)")
    return True, r


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=0,
    sapphire_required=True,
    admin_required=True,
)
