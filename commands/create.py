import discord
import functions as func
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND>"),
        ("Description:",
         "Make a new primary voice channel. When users join this channel, I'll make a new one for them and move them "
         "into it. By default primary channels are named \"+ New Session\" and placed at the top of your server, but "
         "you can safely rename it, move it around and change its permissions.\n\n"
         "You can create as many primary channels as you want and place them in different areas of your server. "
         "They (and the secondary channels I create for them) will inherit the permissions of the category they are in "
         "by default.\n\n"
         "If you move a primary channel into a private/restricted category, **make sure I have permission to create "
         "and edit voice channels there**.\n\n"
         "Secondary channels will copy the perimissions, bitrate and user limit of their primary channel.\n\n"
         "By default secondary channels will be placed above their primary channel. Use *<PREFIX>toggleposition* to "
         "place them below instead."),
    ]
]


async def execute(ctx, params):
    guild = ctx['guild']
    default_name = "➕ New Session"

    try:
        await func.create_primary(guild, default_name, ctx['message'].author)
    except discord.errors.Forbidden:
        return False, "I don't have permission to create channels."
    except discord.errors.HTTPException as e:
        return False, "An HTTPException occurred: {}".format(e.text)

    response = ("A new voice channel called \"{}\" has been created. "
                "You can now move it around, rename it, etc.\n\n"
                "Whenever a user enters this voice channel, a new voice channel will be created above it "
                "for them, and they will automatically be moved to it.\n"
                "When that channel is empty, it will be deleted automatically.\n\n"
                "Use `{}template` to change the naming scheme for the new channels".format(default_name,
                                                                                           ctx['print_prefix']))
    return True, response


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=0,
    admin_required=True,
)
