import discord
import utils
from difflib import SequenceMatcher
from functions import admin_log, get_secondaries, log

from . import (
    alias,
    aliases,
    allyourbase,
    asip,
    bitrate,
    channelinfo,
    create,
    dcnf,
    defaultlimit,
    disable,
    ecnf,
    enable,
    general,
    help_cmd,
    inheritpermissions,
    invite,
    kick,
    limit,
    listroles,
    logging,
    name,
    nick,
    patreon,
    ping,
    power_overwhelming,
    prefix,
    private,
    public,
    removealias,
    rename,
    restrict,
    restrictions,
    servercheck,
    source,
    showtextchannelsto,
    template,
    textchannelname,
    textchannels,
    toggleposition,
    transfer,
    uniquenames,
    unlimit
)

commands = {
    "alias": alias.command,
    "aliases": aliases.command,
    "allyourbase": allyourbase.command,
    "asip": asip.command,
    "bitrate": bitrate.command,
    "channelinfo": channelinfo.command,
    "create": create.command,
    "dcnf": dcnf.command,
    "defaultlimit": defaultlimit.command,
    "disable": disable.command,
    "ecnf": ecnf.command,
    "enable": enable.command,
    "general": general.command,
    "help": help_cmd.command,
    "inheritpermissions": inheritpermissions.command,
    "invite": invite.command,
    "kick": kick.command,
    "votekick": kick.command,
    "limit": limit.command,
    "listroles": listroles.command,
    "lock": limit.command,
    "logging": logging.command,
    "name": name.command,
    "nick": nick.command,
    "patreon": patreon.command,
    "ping": ping.command,
    "power-overwhelming": power_overwhelming.command,
    "poweroverwhelming": power_overwhelming.command,
    "prefix": prefix.command,
    "private": private.command,
    "public": public.command,
    "removealias": removealias.command,
    "rename": rename.command,
    "restrict": restrict.command,
    "restrictions": restrictions.command,
    "servercheck": servercheck.command,
    "source": source.command,
    "showtextchannelsto": showtextchannelsto.command,
    "template": template.command,
    "textchannelname": textchannelname.command,
    "textchannels": textchannels.command,
    "toggleposition": toggleposition.command,
    "transfer": transfer.command,
    "uniquenames": uniquenames.command,
    "unlimit": unlimit.command,
    "unlock": unlimit.command,
}


def help(c):
    commands[c].print_help()


async def run(c, ctx, params):
    if c not in commands:
        if 'dcnf' not in ctx['settings'] or ctx['settings']['dcnf'] is False:
            similar = sorted(commands, key=lambda x: SequenceMatcher(None, x, c).ratio(), reverse=True)[0]
            ratio = SequenceMatcher(None, similar, c).ratio()
            return False, "Sorry, `{}` is not a recognised command.{}".format(
                c, " Did you mean `{}{}`?".format(ctx['print_prefix'], similar) if ratio > 0.65 else "")
        else:
            return False, "NO RESPONSE"

    cmd = commands[c]

    if cmd.admin_required and not ctx['admin']:
        return False, ("You don't have permission to use that command, only managers of this server (i.e. users with "
                       "the \"Manage Channels\" and \"Manage Roles\" permissions) can use that command.")

    restrictions = ctx['settings']['restrictions'] if 'restrictions' in ctx['settings'] else {}
    if not ctx['admin'] and c in restrictions:
        roles = [r.id for r in ctx['message'].author.roles]
        if not any((r in roles) for r in restrictions[c]):
            return False, "You don't have permission to use that command."

    if cmd.sapphire_required and not ctx['sapphire']:
        return False, ("That command is restricted to :gem: **Sapphire Patron** servers.\n"
                       "Become a Sapphire Patron to support the development of this bot and unlock more ~~useless~~ "
                       "amazing features: https://www.patreon.com/pixaal")
    elif cmd.gold_required and not ctx['gold']:
        return False, ("That command is restricted to :credit_card: **Gold Patron** servers.\n"
                       "Become a Gold Patron to support the development of this bot and unlock more ~~useless~~ "
                       "amazing features: https://www.patreon.com/pixaal")

    if cmd.voice_required:
        v = ctx['message'].author.voice
        if v is not None and v.channel.id in get_secondaries(ctx['guild'], ctx['settings']):
            ctx['voice_channel'] = v.channel
        else:
            return False, "You need to be in one of my voice channels to use that command."

    if cmd.creator_only:
        vc = ctx['voice_channel']  # all creator_only commands will also have voice_required
        creator_id = utils.get_creator_id(ctx['settings'], vc)
        ctx['creator_id'] = creator_id
        if not creator_id == ctx['message'].author.id and not ctx['admin']:
            creator_mention = None
            for m in vc.members:
                if m.id == creator_id:
                    creator_mention = m.mention
                    break
            return False, ("Only the person who created this voice channel ({}) is allowed to do that.\n"
                           "If you were the creator originally but then left the channel temporarily, "
                           "the person at the top of the channel at the time became the new designated creator."
                           "".format(creator_mention if creator_mention else "unknown member"))

    if len(params) < cmd.params_required:
        ctx['incorrect_command_usage'] = False
        await help_cmd.command.execute(ctx, [c])
        return False, None

    try:
        r = await cmd.execute(ctx, params)  # Run command
    except discord.errors.Forbidden:
        return False, "I don't have permission to do that :("
    except Exception as e:
        error_text = "Server: `{}`\n`{}` with command `{}`, params_str: `{}`".format(ctx['guild'].id,
                                                                                     type(e).__name__,
                                                                                     c,
                                                                                     ' '.join(params))
        await admin_log(error_text, ctx['client'])
        log(error_text)
        import traceback
        error_text = traceback.format_exc()
        await admin_log(error_text, ctx['client'])
        log(error_text)
        return False, ("A `{}` error occured :(\n"
                       "Please ensure I have the correct permissions, check `{}help {}` for the correct command usage, "
                       "and then try again. \nIf that still doesn't help, try asking in the support server: "
                       "https://discord.gg/qhMrz6u".format(type(e).__name__, ctx['print_prefix'], c))

    if r is None:
        # In case command didn't return success/response
        await admin_log("Server: `{}`\nUnknown Error with command `{}`, params_str: {}".format(ctx['guild'].id,
                                                                                               c,
                                                                                               ' '.join(params)),
                        ctx['client'],
                        important=True)
        return False, ("An unknown error occured :(\n"
                       "Please ensure I have the correct permissions, check `{}help {}` for the correct command usage, "
                       "and then try again. \nIf that still doesn't help, try asking in the support server: "
                       "https://discord.gg/qhMrz6u".format(ctx['print_prefix'], c))

    return r


def reload_command(c):
    m = globals()[c]
    from importlib import reload
    reload(m)
