import utils
import functions as func
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND> `CHANNEL_ID/here/off`"),
        ("Description:",
         "Log voice channel activity in your server to a chosen text channel. \n"
         "Use `<PREFIX><COMMAND> here` to enable logging to this channel, "
         "or enter a channel ID instead of `here` to use a different channel.\n"
         "Use `<PREFIX><COMMAND> off` to disable logging.\n\n"
         "You can optionally specify a logging level by adding `1`/`2`/`3` after your command (e.g. "
         "`<PREFIX><COMMAND> here 3`). The higher the level, the more info is logged:\n"),
        (" ·  Level 1:",
         "Someone creates a new channel; Someone tries creating channels too quickly and is "
         "temporarily put on cooldown; Someone initiates a votekick."),
        (" ·  Level 2:",
         "Someone sets/removes the user limit of their channel; Someone sets a custom bitrate for "
         "themselves; Someone renames their own channel; An empty channel is deleted."),
        (" ·  Level 3:",
         "Someone joins or leaves an existing channel.\n\n"
         "Level 3 logging is only available to 💎 **Sapphire Patron** servers, as it may generate "
         "a large number of messages which could overload the bot and trigger Discord's rate limiting.\n\n"
         "If you don't specify a logging level and haven't done so before, level 1 will be assumed."),
        ("Examples:",
         "<PREFIX><COMMAND> here\n"
         "<PREFIX><COMMAND> here 3\n"
         "<PREFIX><COMMAND> 601032893002940436 2\n"
         "<PREFIX><COMMAND> off"),
    ]
]


async def execute(ctx, params):
    guild = ctx['guild']
    settings = ctx['settings']
    previous_c = False if 'logging' not in settings else str(settings['logging'])
    was_previously_enabled = False
    tc = params[0].lower()
    if tc == previous_c:
        if tc is False:
            return False, "Logging is already disabled."
        was_previously_enabled = True
    if tc == 'off':
        await func.server_log(guild, "📕 Logging is now disabled", 1, settings)
        settings['logging'] = False
        utils.set_serv_settings(guild, settings)
        return True, None
    elif tc == 'here':
        tc = ctx['channel']
    else:
        try:
            tc = int(tc)
        except ValueError:
            return False, ("`{}` is not a valid channel ID. Get the ID by right clicking the channel, "
                           "or just run `{}logging here` in that channel.".format(tc, ctx['print_prefix']))
        tmp = guild.get_channel(tc)
        if tmp is None:
            return False, ("`{}` is not a valid channel ID. Get the ID by right clicking the channel, "
                           "or just run `{}logging here` in that channel.".format(tc, ctx['print_prefix']))
        tc = tmp

    level = 1 if 'log_level' not in settings else settings['log_level']
    if len(params) > 1:
        level = params[1]
        try:
            level = int(level)
        except ValueError:
            return False, "The log level you chose (`{}`) is not a number.".format(level)
        if not (1 <= level <= 3):
            return False, "The log level must be between 1 and 3."
        if level == 3 and not func.is_sapphire(guild):
            return False, ("Only Sapphire Patron servers can use level 3 logging, as it may generate a large "
                           "number of messages which may overload the bot and trigger Discord's rate limiting.")

    perms = tc.permissions_for(guild.me)
    if not perms.send_messages:
        return False, "I don't have permission to send messages to that channel."

    settings['logging'] = tc.id
    settings['log_level'] = level
    utils.set_serv_settings(guild, settings)
    await func.server_log(
        guild,
        ("📘 Logging level set to **{}**".format(level) if was_previously_enabled else
         "📗 Logging (level **{}**) is now enabled in this channel".format(level)),
        1, settings)
    return True, None


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=1,
    admin_required=True,
    gold_required=True,
)
