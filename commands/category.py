from discord import CategoryChannel

import functions as func
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND> `CATEGORY`"),
        ("Description:",
         "Change the category where secondary channels are created."
         "By default they are created in the primary channels category`.\n\n"
         "First join a voice channel, then run the command to change the category for new "
         "secondary channels created by the same primary (\"+ New Session\") channel."),
        ("Examples:",
         "<PREFIX><COMMAND> 814530781489004576"),
    ]
]


async def execute(ctx, params):
    categoryid = ctx['clean_paramstr']
    guild = ctx['guild']
    vc = ctx['voice_channel']

    if categoryid:
        try:
            category = guild.get_channel(int(categoryid))
            if category is None or not isinstance(category, CategoryChannel):
                raise ValueError
        except ValueError:
            return False, ("`{}` is not a valid category ID. "
                           "Use `{}listcategories` to get a list of categories and their IDs.".format(categoryid, ctx['print_prefix']))
        func.set_category(guild, vc.id, category)
        return True, ("Done! From now on, voice channels like the one you're in now will be placed "
                      "in the `{}` category. You should see it update in a few seconds.").format(category.name)
    else:
        return False, ("You need to specify the category for this channel, e.g. '{0}category <categoryid>'.".format(ctx['print_prefix']))


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=1,
    admin_required=True,
    voice_required=True,
)
