import utils
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND>"),
        ("Description:",
         "Toggle whether or not to create temporary private text channels for each voice chat, "
         "for people to spam links, music bot commands, `/tts` commands, or for people without mics to type in. "
         "These channels are only visible to members of each voice chat and get deleted once everyone leaves.\n\n"
         "Admins of the server will be able to see **all** text channels, "
         "which may look a bit ugly if you have a lot of active channels, but fear not, "
         "regular members will only see the one channel assigned to their voice chat.\n\n"
         "To set the channel name for all future text channels, use the `textchannelname` command.\n\n"
         "**OFF** by default."),
        ("Note",
         "As an admin it may be tricky to discern which text channel is yours, since you can see all of them and "
         "they all have the same name. Simply look at the user list on the right when selecting the channel - the "
         "one with the same members as the voice you're in is the one for you.\n"
         "You can safely rename your specific channel to make it easier to find again, "
         "but do not change the channel topic as this is used to find and delete the channel in some cases."),
    ]
]


async def execute(ctx, params):
    guild = ctx['guild']
    settings = ctx['settings']
    textchannels = not settings['text_channels'] if 'text_channels' in settings else True
    settings['text_channels'] = textchannels
    utils.set_serv_settings(guild, settings)
    if textchannels:
        r = "OK, from now on I'll create private text channels for each voice chat."
        perms = guild.me.permissions_in(ctx['channel'])
        if not perms.manage_roles:
            r += ("\n:warning: Make sure I have the **Manage Roles** permission in this server and any categories that "
                  "contain my voice channels, otherwise I won't be able to make the text channels.")
    else:
        r = "Text channel creation is now **OFF** :)"
    return True, r


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=0,
    gold_required=True,
    admin_required=True,
)
