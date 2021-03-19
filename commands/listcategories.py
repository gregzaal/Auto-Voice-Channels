from discord import CategoryChannel
import utils
from functions import echo
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND> `CATEGORY`"),
        ("Description:",
         "List of all the categories that a server has."),
        ("Examples:",
         "<PREFIX><COMMAND>"),
    ]
]


async def execute(ctx, params):
    guild = ctx['guild']

    l = ["```{:^16}".format("ID") + " Creation Date    Name```"]

    for cc in guild.channels:
        if isinstance(cc, CategoryChannel):
            l.append("`{0}`  `{1}`  {2}".format(str(cc.id),
                                                cc.created_at.strftime("%Y/%m/%d"),
                                                cc.name))
    for c in utils.chunks(l, 10):
        await echo('\n'.join(c), ctx['channel'], ctx['message'].author)

    return True, "NO RESPONSE"

command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=0,
    admin_required=True,
    voice_required=False,
)
