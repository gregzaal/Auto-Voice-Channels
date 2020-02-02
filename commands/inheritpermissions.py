import discord
import utils
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND> `primary/category/CHANNEL ID`"),
        ("Description:",
         "Choose where new channels created by a certain primary channel get their permissions from. "
         "You can use this to allow only certain people to create channels, but anyone to join them. "
         "\n\nAvailable options are:"
         "\n ·  `primary`/`parent`: (default) New channels will use the same permissions as the "
         "\"+ New session\" channel they are created from."
         "\n ·  `category`: New channels will use whatever permissions are set up for the category they are in "
         "(the same behavior as creating channels manually)."
         "\n ·  `CHANNEL_ID`: Specify an existing voice channel whose permissions new channels will copy. "
         "Must be a permanent channel that the bot can see - if the channel is ever deleted or becomes inaccessible, "
         "the primary channel's permissions will silently be used instead (as is the default)."),
        ("Examples:",
         "<PREFIX><COMMAND> primary\n"
         "<PREFIX><COMMAND> category\n"
         "<PREFIX><COMMAND> 603174408957198347"),
    ]
]


async def execute(ctx, params):
    mode = ctx['clean_paramstr'].lower()
    guild = ctx['guild']
    settings = ctx['settings']
    c = ctx['voice_channel']

    options = {
        'primary': 'PRIMARY',
        'parent': 'PRIMARY',
        'default': 'PRIMARY',
        'category': 'CATEGORY',
    }

    if mode not in options:
        try:
            mode = int(mode)
        except ValueError:
            return False, ("\"{}\" is not a valid option or channel ID. Please run `{}help inheritpermissions` "
                           "to learn how to use this command.".format(ctx['clean_paramstr'], ctx['print_prefix']))
        perm_channel = guild.get_channel(mode)
        if perm_channel is None:
            return False, ("`{}` is not a valid channel ID, it looks to me like that channel doesn't exist. "
                           "Maybe I don't have permission to see it?".format(mode))
        if not isinstance(perm_channel, discord.VoiceChannel):
            return False, "Sorry, that channel is not a voice channel."
    else:
        mode = options[mode]
        if mode == 'CATEGORY' and c.category is None:
            return False, "Your channel is not in a category."

    for p in settings['auto_channels']:
        for sid in settings['auto_channels'][p]['secondaries']:
            if sid == c.id:
                settings['auto_channels'][p]['inheritperms'] = mode
                utils.set_serv_settings(guild, settings)
                return True, "Done! Note that this will only affect new channels."


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=1,
    gold_required=False,
    admin_required=True,
    voice_required=True,
)
