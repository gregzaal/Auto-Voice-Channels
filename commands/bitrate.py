import utils
import functions as func
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND> `N/reset`"),
        ("Description:",
         "Set a server-wide custom bitrate (in kbps) for yourself that will be used for any channels you join.\n"
         "This can be used either to improve audio quality (e.g. for music channels), "
         "or to lower the bandwidth used for those with limited/expensive internet.\n\n"
         "Note: The bitrate is for the entire channel, not just you. If there are other users in the channel that "
         "have set custom bitrates, the average bitrate will be used.\n\n"
         "If no one in the channel has set a custom bitrate, the bitrate of the primary ('New Session') channel "
         "will be used.\n\n"
         "Use `<PREFIX>channelinfo` to check the current bitrate of the channel you're in."),
        ("Examples:",
         "<PREFIX><COMMAND> 80\n"
         "<PREFIX><COMMAND> reset"),
    ]
]


async def execute(ctx, params):
    params_str = ' '.join(params)
    guild = ctx['guild']
    settings = ctx['settings']
    author = ctx['message'].author
    bitrate = utils.strip_quotes(params_str)
    v = author.voice
    in_vc = v is not None and v.channel.id in func.get_secondaries(guild, settings)
    if bitrate.lower() == 'reset':
        try:
            del settings['custom_bitrates'][str(author.id)]
            utils.set_serv_settings(guild, settings)
        except KeyError:
            return False, "You haven't set a custom bitrate."
        if in_vc:
            await func.update_bitrate(v.channel, settings, reset=True)
        return True, "Your custom bitrate has been reset, the channel default will be used for you from now on."

    try:
        bitrate = float(bitrate)
    except ValueError:
        return False, "`{}` is not a number.".format(bitrate)

    if bitrate < 8:
        return False, "The bitrate must be higher than 8."

    if bitrate * 1000 > guild.bitrate_limit:
        return False, "{} is higher than the maximum bitrate in this server ({}).".format(
            bitrate, guild.bitrate_limit / 1000
        )

    if 'custom_bitrates' not in settings:
        settings['custom_bitrates'] = {}
    settings['custom_bitrates'][str(author.id)] = bitrate
    utils.set_serv_settings(guild, settings)

    if in_vc:
        await func.update_bitrate(v.channel, settings)

    await func.server_log(
        guild,
        "🎚 {} (`{}`) set their custom bitrate to {}kbps".format(
            func.user_hash(author), author.id, bitrate
        ), 2, settings)
    return True, ("Done! From now on, channels you join will have their bitrate set to {}kbps.\n"
                  "If multiple users in the channel have set custom bitrates, the average will be used.\n\n"
                  "Use `{}channelinfo` to check the current bitrate of your channel.".format(bitrate,
                                                                                             ctx['print_prefix']))


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=1,
    gold_required=True,
    admin_required=False,
)
