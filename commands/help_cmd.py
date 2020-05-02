import discord
import traceback
from functions import echo, dm_user, esc_md
from utils import log
from commands.base import Cmd

help_text = [
    [
        ("Usage:", "<PREFIX><COMMAND>\n"
                   "<PREFIX><COMMAND> `COMMAND`"),
        ("Description:", "Get help using this bot, or more information about a particular command."),
        ("Example:", "<PREFIX><COMMAND> template"),
    ]
]


async def execute(ctx, params):
    channel = ctx['channel']
    author = ctx['message'].author
    if not params:
        support_server_id = 601015720200896512
        if not ctx['admin'] and ctx['guild'].id != support_server_id:
            e = discord.Embed(color=discord.Color.from_rgb(205, 220, 57))
            e.title = "Auto Voice Channels"
            e.description = (
                "I'm a bot that allows you to dynamically and infinitely create voice channels as you need them, "
                "and automatically delete them as soon as they are no longer used.\n\n"
                "Simply join a voice channel of mine and I'll create a new one for you and move you to it."
            )
            text = (
                " ·  **<PREFIX>lock** - "
                "Lock the user limit of your voice channel so no more people can join. "
                "Use **<PREFIX>unlock** to remove the limit.\n\n"
                " ·  **<PREFIX>limit `N`** - "
                "Set the user limit of your channel to a particular number. "
                "Use **<PREFIX>unlock** to remove the limit.\n\n"
                " ·  **<PREFIX>private** - "
                "Make your voice channel private, preventing anyone from joining you directly. "
                "Creates a \"⇩ Join {}\" channel above yours so people can request to join you.\n\n"
                " ·  **<PREFIX>kick `@USER`** - "
                "Start a votekick to remove someone from your channel.\n\n"
                " ·  **<PREFIX>transfer `@USER`** - "
                "Transfer ownership of your channel to someone else.\n\n".format(
                    esc_md(author.display_name)
                )
            )
            if ctx['gold']:
                text += (
                    " ·  **<PREFIX>name** - Change the name of your voice channel.\n\n"
                    " ·  **<PREFIX>nick** - Set what channels that show the creator's name will call you.\n\n"
                    " ·  **<PREFIX>bitrate** - Set a server-wide custom bitrate (in kbps) for yourself that will be "
                    "used for any channels you join.\n\n"
                )
            text += (
                " ·  **<PREFIX>invite** - Invite me to another server!\n\n"
                " ·  **<PREFIX>help `command`** - Get more info about a particular command."
            )
            text = text.replace('<PREFIX>', ctx['print_prefix'])
            e.add_field(name="Commands:", value=text)
            try:
                await channel.send(embed=e)
            except discord.errors.Forbidden:
                log("Forbidden to echo", channel.guild)
                await dm_user(
                    author,
                    "I don't have permission to send messages in the "
                    "`#{}` channel of **{}**.".format(channel.name, channel.guild.name)
                )
                return False, "NO RESPONSE"
            return True, "NO RESPONSE"
        can_embed = channel.permissions_for(ctx['guild'].me).embed_links
        with open("docs.md", 'r', encoding='utf8') as f:
            docs = f.read()
        sections = docs.split('** **')
        for i, s in enumerate(sections):
            s = s.replace("@Auto Voice Channels ", "@{} ".format(ctx['message'].guild.me.display_name))
            s = s.replace("vc/", esc_md(ctx['prefix_p']))
            s = s.replace("@pixaal", author.mention)
            s = s.replace(" :)", " :slight_smile:")
            s = s.replace("**Gold Patron**", ":credit_card: **Gold Patron**")
            s = s.replace("Change the prefix of the bot (default is", "Change the prefix of the bot (currently")
            s = s.replace("<https://www.patreon.com/pixaal>", "https://www.patreon.com/pixaal")  # Always embed
            if s.startswith("\n**-- Commands --**\n") and can_embed:
                lines = [l for l in s.split('\n') if l != ""]
                parts = []
                title = []
                end_of_title = False
                cmds = []
                for l in lines:
                    if not l.startswith('`'):
                        if end_of_title:
                            parts.append(["** **\n" + '\n'.join(title), cmds])
                            title = []
                            cmds = []
                            end_of_title = False
                        title.append(l)
                    else:
                        end_of_title = True
                        cmds.append(l)
                parts.append(["** **\n" + '\n'.join(title), cmds])

                for j, p in enumerate(parts):
                    embed = discord.Embed(color=discord.Color.from_rgb(205, 220, 57))
                    for c in p[1]:
                        cmd_name, cmd_desc = c.split(" - ", 1)
                        embed.add_field(name=" ·  " + cmd_name, value=cmd_desc)
                    try:
                        await channel.send(content=p[0].replace("Commands --**", "Commands --**\n"), embed=embed)
                    except discord.errors.Forbidden:
                        log("Forbidden to echo", channel.guild)
                        await dm_user(
                            author,
                            "I don't have permission to send messages in the "
                            "`#{}` channel of **{}**.".format(channel.name, channel.guild.name)
                        )
                        return False, "NO RESPONSE"
                continue
            if i == 0:
                s = '\n'.join(s.strip('\n').split('\n')[:-1])  # Remove last line of first section (gfycat embed)
                s += "\nhttps://gfycat.com/latemealyhoneyeater"
            else:
                s = '** **' + s
            echo_success = await echo(s, channel, author)
            if not echo_success:
                return False, "NO RESPONSE"
        return True, "NO RESPONSE"
    else:
        from commands import commands
        c = params[0]
        if c in commands:
            replacements = {
                "<PREFIX>": ctx['print_prefix'],
                "<COMMAND>": c,
                "<USER>": author.mention,
            }
            help_text = commands[c].help_text
            for part in help_text:
                e = discord.Embed(color=discord.Color.from_rgb(205, 220, 57))
                content = None
                if 'incorrect_command_usage' in ctx and part == help_text[0]:
                    content = "Incorrect command usage, here's some info about the `{}` command:".format(c)
                if part == help_text[-1]:
                    e.set_footer(text="More help: discord.io/DotsBotsSupport  \nSupport me: patreon.com/pixaal",
                                 icon_url=ctx['guild'].me.avatar_url_as(size=32))
                for i, p in enumerate(part):
                    t = ("⠀\n" + p[0]) if i != 0 and not p[0].startswith(" ·  ") else p[0]
                    d = (p[1] + "\n⠀") if i == len(part) - 1 and part == help_text[-1] else p[1]
                    if t == 'title':
                        e.title = d
                    else:
                        for r, rv in replacements.items():
                            t = t.replace(r, rv)
                            d = d.replace(r, rv)
                        e.add_field(name=t, value=d, inline=False)
                try:
                    await channel.send(content=content, embed=e)
                except discord.errors.Forbidden:
                    log("Forbidden to echo", channel.guild)
                    await dm_user(
                        author,
                        "I don't have permission to send messages in the "
                        "`#{}` channel of **{}**.".format(channel.name, channel.guild.name)
                    )
                    return False, "NO RESPONSE"
                except Exception:
                    log("Failed to echo", channel.guild)
                    print(traceback.format_exc())
                    return False, "NO RESPONSE"

            if commands[c].sapphire_required and not ctx['sapphire']:
                await channel.send(
                    "**Note:** This command is restricted to :gem: **Sapphire Patron** servers.\n"
                    "Become a Sapphire Patron to support the development of this bot and unlock more ~~useless~~ "
                    "amazing features: <https://www.patreon.com/pixaal>"
                )
            elif commands[c].gold_required and not ctx['gold']:
                await channel.send(
                    "**Note:** This command is restricted to :credit_card: **Gold Patron** servers.\n"
                    "Become a Gold Patron to support the development of this bot and unlock more ~~useless~~ "
                    "amazing features: <https://www.patreon.com/pixaal>"
                )
            return True, "NO RESPONSE"
        elif c == 'expressions':
            e = discord.Embed(color=discord.Color.from_rgb(205, 220, 57))
            e.title = "Template Expressions"
            e.description = (
                "Expressions are a powerful way to set the channel name based on certain conditions, such as whether "
                "or not the creator has a particular role, what game is being played, and the party size.\n\n"
                "Expressions must be in the following form:\n"
                "```"
                "{{CONDITION ?? TRUE // FALSE}}"
                "```\n"
                "If the `CONDITION` part is met, whatever you wrote in the `TRUE` part will be added to the channel "
                "name, otherwise the `FALSE` part will be used instead. The `FALSE` part is optional and can be "
                "left out (e.g. `{{CONDITION ?? TRUE}}`).\n\n"
                "Anything at all can be written inside the `TRUE`/`FALSE` parts, including other template variables "
                "like `@@num@@` or `@@game_name@@`, or even other nested expressions, "
                "however only a certain things may be used as the `CONDITION`:\n\n"
            )
            e.add_field(
                name=" ·  `ROLE:role id`",
                value="Check whether or not the creator has a particular role.\n\n"
            )
            e.add_field(
                name=" ·  `GAME=game name`",
                value="Check if the game that users in the channel are playing (the same one that "
                "`@@game_name@@` returns, including aliases) matches **exactly** the text provided.\n"
                "You can also use `!=` instead of `=` to match anything **other** than exactly the text provided, "
                "or `:` to match anything that **contains** the text provided. "
                "E.g. `GAME:Call of Duty` will match with *\"Call of Duty: Modern Warfare\"*, "
                "but `GAME=Call of Duty` will not.\n\n"
            )
            e.add_field(
                name=" ·  `LIVE`",
                value="Whether or not the creator of the channel is streaming. Use `LIVE_DISCORD` to only detect "
                "discord's \"Go Live\" streams, or `LIVE_EXTERNAL` for Twitch. `LIVE` will include both.\n\n"
            )
            e.add_field(
                name=" ·  `PLAYERS>number`",
                value="💎 [*patrons only.*](https://patreon.com/pixaal) Check if the number of players in your game "
                "(determined either by Discord Rich Presence or the game activity statuses of members in the channel) "
                "is greater than the number provided. You can also use `<`, `<=`, `>=`, `=` and `!=`.\n\n"
            )
            e.add_field(
                name=" ·  `MAX>number`",
                value="💎 [*patrons only.*](https://patreon.com/pixaal) Check if the maximum number of players "
                "allowed in your game (determined by Discord Rich Presence or the channel limit) is greater than the "
                "number provided. You can also use `<`, `<=`, `>=`, `=` and `!=`.\n\n"
            )
            e.add_field(
                name=" ·  `RICH`",
                value="💎 [*patrons only.*](https://patreon.com/pixaal) Whether or not the current game uses "
                      "Discord Rich Presence, which means `@@num_playing@@`, `@@party_size@@`, `@@party_state@@`, and "
                      "`@@party_details@@` should have reliable values.\n\n"
            )
            try:
                await channel.send(embed=e)
            except discord.errors.Forbidden:
                log("Forbidden to echo", channel.guild)
                await dm_user(
                    author,
                    "I don't have permission to send messages in the "
                    "`#{}` channel of **{}**.".format(channel.name, channel.guild.name)
                )
                return False, "NO RESPONSE"
            e = discord.Embed(color=discord.Color.from_rgb(205, 220, 57))
            e.title = "Examples"
            e.description = (
                "```{{GAME:Left 4 Dead ?? [@@num_playing@@/4]}}```"
                "```{{LIVE??🔴 @@stream_name@@}}```"
                "```{{PLAYERS=1 ?? LFG}}```"
                "```{{PLAYERS<=20 ?? ## [@@game_name@@] // It's a party!}}```"
                "```{{MAX=@@num_playing@@ ?? (Full) // (@@num_playing@@)}}```"
                "```{{RICH??@@party_details@@{{MAX>1?? (@@num_playing@@/@@party_size@@)}}}}```"
                "```{{ROLE:601025860614750229 ?? {{ROLE:615086491235909643??[UK] // {{ROLE:607913610139664444??[DE] // "
                "[EU]}}}}}}```\n"
                "The spaces around the `??` and `//` improve readability but may not be desired if you do not want any "
                "spaces around the result.\n\n"
                "If you have a question or need any help setting up an expression, "
                "please ask me in the [support server](https://discord.io/DotsBotsSupport). "
                "I'd be happy to add any extra variables you need."
            )
            await channel.send(embed=e)
            return True, "NO RESPONSE"
        else:
            if 'dcnf' not in ctx['settings'] or ctx['settings']['dcnf'] is False:
                return False, ("`{}` is not a recognized command. Run '**{}help**' "
                               "to get a list of commands".format(c, ctx['print_prefix']))
            else:
                return False, "NO RESPONSE"


command = Cmd(
    execute=execute,
    help_text=help_text,
    params_required=0,
    admin_required=False,
)
