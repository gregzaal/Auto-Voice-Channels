import discord
import functions as func
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND> GROUP NAME"),
        ("Description:",
         "Make a new voice channel group. This will create a new catagory containing a primary channel that will create secondary channels, as well as a \n"
         "'Tavern' channel that will be used for holding the entire group, and a text channel for chatting and bot commands (You can also create another private\n"
         "text channel for commands if you wish, it just needs to be under the same category and you will need to give the bot permission to use it ). After\n"
         "creating this gorup, you can use the <PREFIX>merge (or <PREFIX>m) command to move all users out of their voice channels made in the category and place them into\n"
         "the 'Tavern' channel. You can then use <PREFIX>split (or <PREFIX>sp) to move all the users out of the 'Tavern' channel and back into the ones they came from"),
    ]
]


async def execute(ctx, params):
    guild = ctx['guild']
    default_name = "➕ New Session"
    group_name = ' '.join(params)

    try:
        await func.create_group(guild, group_name, default_name, ctx['message'].author)
    except discord.errors.Forbidden:
        return False, "I don't have permission to create categories."
    except discord.errors.HTTPException as e:
        return False, "An HTTPException occurred: {}".format(e.text)

    response = ("A new voice channel group called " + group_name + " has been created. "
                "You can now use the split and merge commnands within this category\n".format(default_name,
                                                                                           ctx['print_prefix']))
    return True, response


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=0,
    admin_required=True,
)
