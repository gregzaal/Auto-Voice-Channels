import cfg
import os
import utils
import functions as func
from commands.base import Cmd

try:
    import patreon_info
except ImportError:
    patreon_info = None

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND>"),
        ("Description:",
         "Authenticate yourself as a patron and set this server as your primary server "
         "where your rewards will be unlocked."),
    ]
]


async def execute(ctx, params):
    author = ctx['message'].author
    r = "Checking..."
    s = False
    m = await ctx['channel'].send(r)

    if patreon_info is None:
        return False, "No need to do that."

    patrons = patreon_info.fetch_patrons(force_update=False)
    patrons[cfg.CONFIG['admin_id']] = "sapphire"
    auth_path = os.path.join(cfg.SCRIPT_DIR, "patron_auths.json")
    if author.id in patrons:
        auths = utils.read_json(auth_path)
        auths[str(author.id)] = {"servers": [ctx['guild'].id]}
        utils.write_json(auth_path, auths, indent=4)
        patreon_info.update_patron_servers(patrons)
        s = True
        reward = patrons[author.id].title()
        await func.admin_log("🔑 Authenticated **{}**'s {} server {} `{}`".format(
            author.name, reward, ctx['guild'].name, ctx['guild'].id
        ), ctx['client'], important=True)
        r = "✅ Nice! This server is now a **{}** server.".format(reward)
        if reward in ["Diamond", "Sapphire"]:
            r += ("\nPlease give me ~{} hours to set up your private bot - "
                  "I'll DM you when it's ready to make the swap!".format(12 if reward == "Sapphire" else 24))
    else:
        await func.admin_log("🔒 Failed to authenticate for **{}**".format(author.name), ctx['client'])
        r = ("❌ Sorry it doesn't look like you're a Patron.\n"
             "If you just recently became one, please make sure you've connected your discord account "
             "(<https://bit.ly/2UdfYbQ>) and try again in a few minutes. "
             "If it still doesn't work, let me know in the support server: <https://discord.io/DotsBotsSupport>.")
    await m.edit(content=r)
    return s, "NO RESPONSE"


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=0,
    admin_required=True,
)
