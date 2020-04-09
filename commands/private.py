import cfg
import discord
import utils
import functions as func
from commands.base import Cmd
from time import time

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND>"),
        ("Description:",
         "Make your voice channel private, preventing anyone from joining you directly.\n\n"
         "Creates a \"⇩ Join (username)\" channel above yours so people can request to join you. "
         "When someone joins that channel, I'll send you a message asking you to "
         "approve/deny/block their request."),
    ]
]


async def execute(ctx, params):
    guild = ctx['guild']
    settings = ctx['settings']
    author = ctx['message'].author
    vc = ctx['voice_channel']

    for p, pv in settings['auto_channels'].items():
        for s, sv in pv['secondaries'].items():
            if s == vc.id:
                if 'priv' in sv and sv['priv']:
                    return False, ("Your channel is already private. "
                                   "Use `{}public` to make it public again.".format(ctx['print_prefix']))
                try:
                    await vc.set_permissions(author, connect=True)
                    await vc.set_permissions(guild.default_role, connect=False)
                except discord.errors.Forbidden:
                    return False, ("I don't have permission to do that."
                                   "Please make sure I have the *Manage Roles* permission in this server and category.")
                settings['auto_channels'][p]['secondaries'][s]['priv'] = True
                settings['auto_channels'][p]['secondaries'][s]['msgs'] = ctx['channel'].id
                utils.set_serv_settings(guild, settings)
                cfg.PRIV_CHANNELS[s] = {
                    'creator': author,
                    'voice_channel': vc,
                    'primary_id': p,
                    'text_channel': ctx['channel'],
                    'guild_id': guild.id,
                    'request_time': time(),
                    'prefix': ctx['print_prefix'],
                }
                return True, ("Your channel is now private!\n"
                              "A \"**⇩ Join {}**\" channel will appear above your one shortly. "
                              "When someone enters this channel to request to join you, "
                              "I'll send a message here asking you to approve or deny their request.\n"
                              "Use `{}public` to make it public again."
                              "".format(func.esc_md(author.display_name), ctx['print_prefix']))
    return False, "It doesn't seem like you're in a voice channel anymore."


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=0,
    admin_required=False,
    voice_required=True,
    creator_only=True,
)
