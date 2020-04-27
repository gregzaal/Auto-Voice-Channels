import asyncio
import os
import traceback
from datetime import datetime
from copy import deepcopy
from math import ceil
from random import choice, seed
from statistics import mean
from time import time

import cfg
import discord
import translate
import utils
from utils import log

try:
    import patreon_info
except ImportError:
    patreon_info = None


@utils.func_timer()
def lock_channel_request(channel, offset=0):
    cfg.CURRENT_REQUESTS[channel.id] = time() + offset
    # print("Locking", channel.id, cfg.CURRENT_REQUESTS)


@utils.func_timer()
def channel_is_requested(channel):
    # print("Checking", channel.id, cfg.CURRENT_REQUESTS)
    channel_age = datetime.utcnow().timestamp() - channel.created_at.timestamp()
    if channel_age < 5:
        return True
    if channel.id in cfg.CURRENT_REQUESTS:
        if time() - cfg.CURRENT_REQUESTS[channel.id] < 5:
            return True
    return False


@utils.func_timer()
def unlock_channel_request(channel):
    try:
        del cfg.CURRENT_REQUESTS[channel.id]
    except KeyError:
        pass
    # print("Unlocking", channel.id, cfg.CURRENT_REQUESTS)


@utils.func_timer()
def lock_user_request(user, offset=0):
    cfg.USER_REQUESTS[user.id] = time() + offset


@utils.func_timer()
def user_request_is_locked(user):
    if user.id in cfg.USER_REQUESTS:
        if time() - cfg.USER_REQUESTS[user.id] < 2:
            return True
    return False


@utils.func_timer()
def detect_abuse(user):
    if user.id in cfg.USER_REQUESTS:
        v = 1 if user.id not in cfg.USER_ABUSE_EVENTS else cfg.USER_ABUSE_EVENTS[user.id] + 1
        cfg.USER_ABUSE_EVENTS[user.id] = v
        return v
    return False


@utils.func_timer()
def esc_md(text):
    return discord.utils.escape_markdown(text)


@utils.func_timer()
def user_hash(user):
    return esc_md(user.name) + '#' + user.discriminator


@utils.func_timer()
def check_primary_permissions(channel, me):
    perms = channel.permissions_for(me)
    perms_required = [
        perms.manage_channels,
        perms.read_messages,
        perms.send_messages,
        perms.move_members,
    ]
    if channel.category:
        perms = channel.category.permissions_for(me)
        perms_required += [
            perms.manage_channels,
            perms.read_messages,
            perms.send_messages,
            perms.move_members,
        ]
    return all(perms_required)


@utils.func_timer()
def set_template(guild, chid, template):
    settings = utils.get_serv_settings(guild)
    for p in settings['auto_channels']:
        for sid in settings['auto_channels'][p]['secondaries']:
            if sid == chid:
                settings['auto_channels'][p]['template'] = template
                utils.set_serv_settings(guild, settings)
                return


@utils.func_timer()
async def set_default_limit(guild, c, limit):
    chid = c.id
    await c.edit(user_limit=limit)
    settings = utils.get_serv_settings(guild)
    for p in settings['auto_channels']:
        for sid in settings['auto_channels'][p]['secondaries']:
            if sid == chid:
                settings['auto_channels'][p]['limit'] = limit
                utils.set_serv_settings(guild, settings)
                pc = guild.get_channel(int(p))
                if pc.user_limit:
                    await pc.edit(user_limit=0)
                return


@utils.func_timer()
def toggle_position(guild, chid):
    settings = utils.get_serv_settings(guild)
    for p in settings['auto_channels']:
        for sid in settings['auto_channels'][p]['secondaries']:
            if sid == chid:
                above = True
                if 'above' in settings['auto_channels'][p]:
                    above = settings['auto_channels'][p]['above']
                settings['auto_channels'][p]['above'] = not above
                utils.set_serv_settings(guild, settings)
                above = not above
                return "above" if above else "below"
    return "error"


@utils.func_timer()
def get_channel_games(channel):
    settings = utils.get_serv_settings(channel.guild)
    general = ["General"] if 'general' not in settings else [settings['general']]
    games = {}
    for m in sorted(channel.members, key=lambda x: x.display_name.lower()):
        if not m.bot:
            for act in [a for a in m.activities if a.type == discord.ActivityType.playing]:
                gname = act.name

                if gname == "Custom Status":
                    continue

                if gname in games:
                    games[gname] += 1
                else:
                    games[gname] = 1

    if not games:
        return general

    games_l = list((x, games[x]) for x in games)  # Convert dict to 2D list
    games_l.sort(key=lambda c: c[1], reverse=True)  # Sort by most players
    biggest_game, most_players = games_l[0]
    gnames = [biggest_game]
    games_l = games_l[1:]  # remaining games (excluding most popular one)
    for gn, gp in games_l:
        if gp == most_players:
            gnames.append(gn)
    if len(gnames) > 2:
        # More than 2 games with the same number of players
        return general
    else:
        return gnames


@utils.func_timer()
def get_alias(g, settings):
    std_aliases = {
        "League of Legends": "LoL",
        "Counter-Strike: Global Offensive": "CS:GO",
        "Team Fortress 2": "TF2",
        "Grand Theft Auto V": "GTAV",
        "PLAYERUNKNOWN'S BATTLEGROUNDS": "PUBG",
        "MONSTER HUNTER: WORLD": "MH:W",
        "The Elder Scrolls V: Skyrim": "Skyrim",
        "The Elder Scrolls V: Skyrim Special Edition": "Skyrim",
        "The Elder Scrolls Online": "ESO",
        "Tom Clancy's Rainbow Six Siege": "Rainbow Six Siege",
        "FINAL FANTASY XIV": "FFXIV",
        "FINAL FANTASY XIV Online": "FFXIV",
        "Warhammer End Times Vermintide": "Vermintide 1",
        "Warhammer: Vermintide 2": "Vermintide 2",
        "World of Warcraft Classic": "WoW Classic",
        "World of Warcraft": "WoW",
        "Call of Dutyː Modern Warfare": "CoDːMW",
        "Call of Duty®️ː Modern Warfare®️": "CoDːMW",
    }

    if g in settings['aliases']:
        g = settings['aliases'][g]
    elif g in std_aliases:
        g = std_aliases[g]

    return g


@utils.func_timer()
def get_game_name(channel, games):
    settings = utils.get_serv_settings(channel.guild)
    general = ["General"] if 'general' not in settings else [settings['general']]

    if games == general:
        return games[0]

    for i, g in enumerate(games):
        games[i] = get_alias(g, settings)

    tmp = games
    games = []
    for g in tmp:
        if g not in games:
            games.append(g)

    return ', '.join(games)


@utils.func_timer()
def get_party_info(channel, game, asip, default=""):
    settings = utils.get_serv_settings(channel.guild)
    parties = {}
    states = {}
    details = {}
    num_playing = {}
    sizes = {}
    sneakies = 0
    for m in channel.members:
        act = m.activity
        act_name = get_alias(act.name, settings) if act else None
        if act and act_name == game:
            pid = -1
            if hasattr(act, 'party') and act.party:
                if 'id' in act.party:
                    pid = act.party['id']
            if pid == -1:
                # No party ID is given, so we make our own based on other info
                pid = act_name
                if hasattr(act, 'party') and act.party:
                    if 'size' in act.party:
                        pid += ('/'.join(str(v) for v in act.party['size']))
                if hasattr(act, 'state') and act.state:
                    pid += act.state
                if hasattr(act, 'details') and act.details:
                    pid += act.details

            if hasattr(act, 'state') and act.state:
                states[pid] = act.state
            if hasattr(act, 'details') and act.details:
                details[pid] = act.details
            if hasattr(act, 'party') and act.party:
                if 'size' in act.party:
                    num_playing[pid] = str(act.party['size'][0])
                    try:
                        sizes[pid] = str(act.party['size'][1])
                    except IndexError:
                        sizes[pid] = "0"

            parties[pid] = parties[pid] + 1 if pid in parties else 1
        elif not act and asip:
            sneakies += 1

    biggest_party = [None, 0]
    for p, v in parties.items():
        if v > biggest_party[1]:
            biggest_party = [p, v]
    pid, players = biggest_party
    info = {
        'state': default,
        'details': default,
        'rich': False,
        'sneakies': "0",
        'num_playing': "0",
        'size': "0",
    }
    if pid is not None:
        info['state'] = states[pid] if pid in states else default
        info['details'] = details[pid] if pid in details else default
        info['rich'] = pid in states or pid in details
        info['sneakies'] = sneakies
        if pid in num_playing:
            info['num_playing'] = num_playing[pid]
        else:
            info['num_playing'] = str(players + sneakies)
        if pid in sizes:
            info['size'] = sizes[pid]
        elif channel.user_limit:
            info['size'] = str(channel.user_limit)
    return info


@utils.func_timer()
async def update_bitrate(channel, settings, user_left=None, reset=False):
    if 'custom_bitrates' not in settings:
        return False

    custom_bitrates = []
    for m in channel.members:
        if str(m.id) in settings['custom_bitrates']:
            custom_bitrates.append(settings['custom_bitrates'][str(m.id)])

    if not custom_bitrates:
        if reset or (user_left and str(user_left.id) in settings['custom_bitrates']):
            p = utils.get_primary_channel(channel.guild, settings, channel)
            bitrate = p.bitrate
        else:
            return False
    else:
        bitrate = min(channel.guild.bitrate_limit, mean(custom_bitrates) * 1000)

    if bitrate == channel.bitrate:
        return False

    await channel.edit(bitrate=bitrate)
    return bitrate


@utils.func_timer()
async def update_text_channel_role(guild, member, channel, mode):
    if mode == 'leave' and len(channel.members) <= 0:
        return  # Last person leaving, channel will be deleted, no need to update roles

    settings = utils.get_serv_settings(guild)
    for p, pv in settings['auto_channels'].items():
        for s, sv in pv['secondaries'].items():
            if s == channel.id:
                if 'tcr' in sv:
                    r = guild.get_role(sv['tcr'])
                    if r:
                        if mode == 'join':
                            await member.add_roles(r)
                        elif mode == 'leave':
                            try:
                                await member.remove_roles(r)
                            except discord.errors.NotFound:
                                pass  # It's possible someone joins too quick and the role doesn't exist yet?

                        # Ensure existing members have the role in case they joined too quickly
                        members = [m for m in channel.members if m != member]
                        for m in members:
                            if r not in m.roles:
                                await m.add_roles(r)
                        return


@utils.func_timer()
async def dm_user(user, msg, embed=None, error=True):
    if user is None:
        log("Failed to DM unknown user.")
        return

    if user.dm_channel is None:
        await user.create_dm()

    try:
        last_message = await user.dm_channel.history(limit=1).flatten()
    except discord.errors.Forbidden:
        log("Forbidden to get user dm_history {}".format(user.id))
        return

    if len(last_message) > 0:
        last_message = last_message[0]
    else:
        last_message = None

    if error and last_message and last_message.id in cfg.DM_ERROR_MESSAGES:
        return
    try:
        m = await user.dm_channel.send(content=msg, embed=embed)
        if error:
            cfg.DM_ERROR_MESSAGES[m.id] = time()
    except discord.errors.Forbidden:
        log("Forbidden to DM user {}".format(user.id))


@utils.func_timer()
async def echo(msg, channel, user=None):
    max_chars = 1950  # Discord has a character limit of 2000 per message. Use 1950 to be safe.
    msg = str(msg)
    if len(msg) > max_chars:
        chunks = list([msg[i:i + max_chars] for i in range(0, len(msg), max_chars)])
    else:
        chunks = [msg]

    for c in chunks:
        try:
            await channel.send(c)
        except discord.errors.Forbidden:
            log("Forbidden to echo", channel.guild)
            if user:
                await dm_user(
                    user,
                    "I don't have permission to send messages in the "
                    "`#{}` channel of **{}**.".format(channel.name, channel.guild.name)
                )
            return False
        except Exception:
            log("Failed to echo", channel.guild)
            print(traceback.format_exc())
            return False
    return True


@utils.func_timer()
async def blind_echo(msg, guild):
    settings = utils.get_serv_settings(guild)
    msg_channel = None
    last_message = None
    if 'last_channel' in settings:
        msg_channel = guild.get_channel(settings['last_channel'])
        if msg_channel:
            last_message = msg_channel.last_message
    if not msg_channel:
        server_contact = guild.get_member(settings['server_contact'])
        if server_contact is not None:
            if server_contact.dm_channel is None:
                await server_contact.create_dm()
            msg_channel = server_contact.dm_channel
            last_message = await msg_channel.history(limit=1).flatten()
            if len(last_message) > 0:
                last_message = last_message[0]
    if msg_channel:
        if last_message and last_message.id in cfg.ERROR_MESSAGES:
            # Don't spam multiple error messages in a row
            return
        try:
            m = await msg_channel.send(msg)
        except:
            settings['last_channel'] = 0  # Don't try use this channel in future
            utils.set_serv_settings(guild, settings)
            return
        cfg.ERROR_MESSAGES[m.id] = time()


@utils.func_timer()
async def admin_log(msg, client, important=False):
    admin = client.get_user(cfg.CONFIG['admin_id'])
    if admin.dm_channel is None:
        await admin.create_dm()
    mention = admin.mention
    if important and len(msg + "\n" + mention) <= 2000:
        msg = msg + "\n" + mention

    admin_channel = admin.dm_channel
    if 'admin_channel' in cfg.CONFIG:
        admin_channel = client.get_channel(cfg.CONFIG['admin_channel'])

    await admin_channel.send(msg)


@utils.func_timer()
async def log_timings(client, highlight):
    text = ""
    if highlight is not None:
        text = "**{0}** took {1:.2f}s".format(highlight, cfg.TIMINGS[highlight])
    log(text.replace("**", ""))
    text += "\n" + utils.format_timings()
    await admin_log(text, client)


@utils.func_timer()
async def server_log(guild, msg, msg_level, settings=None):
    if settings is None:
        settings = utils.get_serv_settings(guild)
    if 'logging' not in settings or settings['logging'] is False:
        return

    log_level = settings['log_level']
    if msg_level > log_level:
        return

    if not is_gold(guild):
        return

    if msg_level == 3 and not is_sapphire(guild):
        return

    try:
        channel = guild.get_channel(settings['logging'])
    except:
        # Channel no longer exists, or we can't get it, either way we can't log anything.
        return

    try:
        msg = msg.replace('➕', '＋')  # Make the default plus sign more visible
        await channel.send(msg)
    except discord.errors.Forbidden:
        log("Forbidden to log", guild)
    except Exception:
        log("Failed to log", guild)
        print(traceback.format_exc())

    return


@utils.func_timer()
async def check_patreon(force_update=False, client=None):
    if patreon_info is None:
        return

    print("Checking Patreon...{}".format(" (F)" if force_update else ""))
    previous_patrons = deepcopy(cfg.PATRONS)
    patrons = patreon_info.fetch_patrons(force_update=force_update)

    if client and previous_patrons and patrons != previous_patrons:
        for p, r in patrons.items():
            if p not in previous_patrons:
                pu = client.get_user(p)
                try:
                    pn = pu.display_name
                except AttributeError:
                    pn = "<UNKNOWN>"
                important = True if r in ['sapphire', 'diamond'] else False
                await admin_log("🎉 New {} patron! **{}** (`{}`)".format(cfg.TIER_ICONS[r], pn, p), client, important)
                msg = ("🎉 **Thanks for your support!** 🎉\nTo activate your patron-exclusive features, "
                       "simply run `vc/power-overwhelming` in your server.")
                if r in ['sapphire', 'diamond']:
                    msg += "\n\nGive me a few hours to set up your private "
                    msg += "bot" if r == 'sapphire' else "server"
                    msg += ", and then I'll contact you in the support server to make the switch."
                    if r == 'diamond':
                        msg += ("\nPlease let me know whether you prefer a server in Europe, "
                                "North America or Asia by replying to this message.")
                await dm_user(pu, msg)

        for p, r in previous_patrons.items():
            if p not in patrons and p != cfg.CONFIG['admin_id']:
                pu = client.get_user(p)
                try:
                    pn = pu.display_name
                except AttributeError:
                    pn = "<UNKNOWN>"
                important = True if r in ['sapphire', 'diamond'] else False
                await admin_log("😱 Lost {} patron! **{}** (`{}`)".format(cfg.TIER_ICONS[r], pn, p), client, important)

    patreon_info.update_patron_servers(patrons)
    print("{} patrons".format(len(patrons)))


@utils.func_timer()
def is_gold(guild):
    if patreon_info is None:
        return True

    gold_servers = [
        607246684367618049,  # T4
    ]
    if isinstance(guild, int):
        guild_id = guild
    else:
        guild_id = guild.id
    gold_servers += cfg.GOLD_SERVERS
    return guild_id in gold_servers or is_sapphire(guild_id)


@utils.func_timer()
def is_sapphire(guild):
    if patreon_info is None:
        return True

    sapphire_servers = [
        332246283601313794,  # Salt Sanc
        601015720200896512,  # Dots Bots
        460459401086763010,  # T1
        607246539101831168,  # T2
    ]
    if isinstance(guild, int):
        guild_id = guild
    else:
        guild_id = guild.id
    sapphire_servers += cfg.SAPPHIRE_SERVERS
    return guild_id in sapphire_servers


@utils.func_timer()
def get_sapphire_id(guild):
    for s, sv in cfg.CONFIG["sapphires"].items():
        if guild.id in sv["servers"]:
            return int(s)
    return None


@utils.func_timer()
async def power_overwhelming(ctx, guild):
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
        auths[str(author.id)] = {"servers": [guild.id]}
        utils.write_json(auth_path, auths, indent=4)
        patreon_info.update_patron_servers(patrons)
        s = True
        reward = patrons[author.id].title()
        await admin_log("🔑 Authenticated **{}**'s {} server {} `{}`".format(
            author.name, reward, guild.name, guild.id
        ), ctx['client'], important=True)
        r = "✅ Nice! This server is now a **{}** server.".format(reward)
        if reward in ["Diamond", "Sapphire"]:
            r += ("\nPlease give me ~{} hours to set up your private bot - "
                  "I'll DM you when it's ready to make the swap!".format(12 if reward == "Sapphire" else 24))
    else:
        await admin_log("🔒 Failed to authenticate for **{}**".format(author.name), ctx['client'])
        r = ("❌ Sorry it doesn't look like you're a Patron.\n"
             "If you just recently became one, please make sure you've connected your discord account "
             "(<https://bit.ly/2UdfYbQ>) and try again in a few minutes. "
             "If it still doesn't work, let me know in the support server: <https://discord.io/DotsBotsSupport>.")
    await m.edit(content=r)
    return s, "NO RESPONSE"


@utils.func_timer()
def get_guilds(client):
    guilds = []
    am_sapphire_bot = cfg.SAPPHIRE_ID is not None
    am_gold_bot = 'gold_id' in cfg.CONFIG and client.user.id == cfg.CONFIG['gold_id']
    for g in client.guilds:
        if g is not None and g.name is not None:
            if am_sapphire_bot:
                if is_sapphire(g) and g.id in cfg.CONFIG["sapphires"][str(cfg.SAPPHIRE_ID)]["servers"]:
                    guilds.append(g)
            elif am_gold_bot:
                if is_gold(g):
                    guilds.append(g)
            else:
                if not is_sapphire(g) or get_sapphire_id(g) is None:
                    guilds.append(g)
    return guilds


@utils.func_timer()
async def react(message, r):
    try:
        await message.add_reaction(r)
    except discord.errors.Forbidden:
        return False
    except discord.errors.NotFound:
        return False
    return True


@utils.func_timer()
async def custom_name(guild, c, u, n):
    settings = utils.get_serv_settings(guild)
    for p, pv in settings['auto_channels'].items():
        for s, sv in pv['secondaries'].items():
            if s == c.id:
                if n.lower() == 'reset':
                    del settings['auto_channels'][p]['secondaries'][s]['name']
                else:
                    if 'uniquenames' in settings and settings['uniquenames']:
                        existing_names = []
                        for t_p, t_pv in settings['auto_channels'].items():
                            for t_s, t_sv in t_pv['secondaries'].items():
                                if 'name' in t_sv and t_s != c.id:
                                    existing_names.append(t_sv['name'])
                        if n in existing_names:
                            return False, "That name is already used by another channel, please pick another."
                    settings['auto_channels'][p]['secondaries'][s]['name'] = n
                utils.set_serv_settings(guild, settings)
                await server_log(
                    guild,
                    ":regional_indicator_n: {} (`{}`) changed the channel (`{}`) name to \"{}\"".format(
                        user_hash(u), u.id, c.id, esc_md(n)
                    ), 2, settings)
    return True, None


@utils.func_timer()
async def set_creator(guild, cid, creator):
    settings = utils.get_serv_settings(guild)
    for p, pv in settings['auto_channels'].items():
        for s, sv in pv['secondaries'].items():
            if s == cid:
                settings['auto_channels'][p]['secondaries'][s]['creator'] = creator.id
                try:
                    jc = guild.get_channel(settings['auto_channels'][p]['secondaries'][s]['jc'])
                    await jc.edit(name="⇩ Join {}".format(creator.display_name))
                except (KeyError, AttributeError):
                    pass
                if s in cfg.PRIV_CHANNELS:
                    cfg.PRIV_CHANNELS[s]['creator'] = creator
                break
    utils.set_serv_settings(guild, settings)
    return True


@utils.func_timer(1.5)
async def rename_channel(guild, channel, settings, primary_id, templates=None, i=-1, ignore_lock=False):
    if not settings:
        settings = utils.get_serv_settings(guild)
    if ignore_lock and not channel.members:
        # Sometimes channel.members doesn't update immediately after moving user into it.
        await asyncio.sleep(1)
        channel = guild.get_channel(channel.id)
    if not templates:
        templates = {}
        if "template" in settings['auto_channels'][primary_id]:
            try:
                templates[channel.id] = settings['auto_channels'][primary_id]['template']
            except AttributeError:
                return  # channel has no ID
    if channel.members and (ignore_lock or not channel_is_requested(channel)):
        if channel.id in templates:
            cname = templates[channel.id]
        else:
            cname = settings['channel_name_template']

        guild_is_gold = is_gold(guild)
        guild_is_sapphire = is_sapphire(guild)

        has_expression = '{{' in cname and '}}' in cname and cname.count('{{') == cname.count('}}') and guild_is_gold
        is_private = settings['priv'] if 'priv' in settings else False

        cname = cname.replace("@@num_players@@", "@@num_playing@@")  # Common mistake

        if '@@game_name@@' in cname or '@@party_' in cname or '@@num_playing@@' in cname or has_expression:
            games = get_channel_games(channel)
            gname = get_game_name(channel, games)

        if '@@party_' in cname or '@@num_playing@@' in cname or has_expression:
            party = get_party_info(channel, gname, settings['asip'] if 'asip' in settings else False)

        if ('@@creator@@' in cname or
                ('general' in settings and '@@creator@@' in settings['general']) or
                '@@num_others@@' in cname or
                '@@stream_name@@' in cname or
                has_expression or is_private):
            creator = None
            creator_name = "Unknown"
            creator_id = utils.get_creator_id(settings, channel)
            if creator_id:
                creator_found = False
                for m in channel.members:
                    if m.id == creator_id:
                        creator_found = True
                        creator = m
                        creator_name = utils.get_display_name(settings, m)
                        break
                if not creator_found:  # Creator not in channel anymore, use top member
                    members = [m for m in channel.members if not m.bot]
                    if members:
                        creator = sorted(members, key=lambda x: x.display_name.lower())[0]
                        await set_creator(guild, channel.id, creator)
                        creator_name = utils.get_display_name(settings, creator)
                        creator_id = creator.id
                    else:
                        # Only time we can get here is if a bot is the last one in the channel,
                        # meaning it'll be deleted very soon and we can skip renaming it.
                        return

        i_str = str(i + 1)
        if i == -1:
            i_str = "?"
        cname = cname.replace('##', '#' + i_str)
        for x in range(5):
            cname = cname.replace('${}#'.format('0' * x), i_str.zfill(x + 1))

        random_set = 0
        while (guild_is_gold and
               '[[' in cname and
               ']]' in cname and
               ('/' in cname.split('[[', 1)[1].split(']]', 1)[0] or
                '\\' in cname.split('[[', 1)[1].split(']]', 1)[0])):
            seed_c = channel.id + random_set
            seed_d = cfg.SEED + channel.id + random_set
            b, m = cname.split('[[', 1)
            m, e = m.split(']]', 1)
            if '\\' in m:
                words = m.split('\\')
                seed(seed_d)
                m = choice(words)
            else:
                words = m.split('/')
                seed(seed_c)
                m = choice(words)
            cname = b + m + e
            random_set += 1

        if '@@nato@@' in cname and guild_is_gold:
            nato = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliett',
                    'Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa', 'Quebec', 'Romeo', 'Sierra', 'Tango',
                    'Uniform', 'Victor', 'Whiskey', 'X Ray', 'Yankee', 'Zulu']
            if i < len(nato):
                nato = nato[i]
            else:
                nato = nato[i % len(nato)] + " " + str(ceil((i + 1) / len(nato)))
            cname = cname.replace('@@nato@@', nato)

        if '@@num@@' in cname:
            members = [m for m in channel.members if not m.bot]
            cname = cname.replace('@@num@@', str(len(members)))

        if '@@num_playing@@' in cname and guild_is_sapphire:
            cname = cname.replace('@@num_playing@@', party['num_playing'])

        if '@@party_size@@' in cname and guild_is_sapphire:
            cname = cname.replace('@@party_size@@', party['size'])

        if '@@party_state@@' in cname and guild_is_sapphire:
            cname = cname.replace('@@party_state@@', party['state'])

        if '@@party_details@@' in cname and guild_is_sapphire:
            cname = cname.replace('@@party_details@@', party['details'])

        others = -1
        if '@@num_others@@' in cname:
            others = len([m for m in channel.members if (
                not m.bot and
                m.id != creator_id
            )])
            cname = cname.replace('@@num_others@@', str(others))

        while ('<<' in cname and
               '>>' in cname and
               ('/' in cname.split('<<', 1)[1].split('>>', 1)[0] or
                '\\' in cname.split('<<', 1)[1].split('>>', 1)[0])):
            b, m = cname.split('<<', 1)
            m, e = m.split('>>', 1)
            c = None
            if m.count('/') == 1:
                c = '/'
                n = len([m for m in channel.members if not m.bot])
            elif m.count('\\') == 1:
                c = '\\'
                if others == -1:
                    n = len([m for m in channel.members if (
                        not m.bot and
                        m.id != utils.get_creator_id(settings, channel)
                    )])
                else:
                    n = others
            if c is not None:
                s, p = m.split(c, 1)
                if n == 1:
                    m = s
                else:
                    m = p
            cname = b + m + e

        if '@@bitrate@@' in cname and guild_is_gold:
            cname = cname.replace('@@bitrate@@', "{}kbps".format(round(channel.bitrate / 1000)))

        while '{{' in cname and '}}' in cname and cname.count('{{') == cname.count('}}') and guild_is_gold:
            m, e = cname.split('}}', 1)
            sections = m.split('{{')
            b = '{{'.join(sections[:-1])
            m = sections[-1]

            m = utils.eval_expression(m, guild_is_sapphire, creator, party, gname)
            cname = b + m + e

        if '@@game_name@@' in cname:
            cname = cname.replace('@@game_name@@', gname)

        if '@@creator@@' in cname:
            cname = cname.replace('@@creator@@', creator_name)

        if '@@stream_name@@' in cname:
            stream_name = ""
            for act in creator.activities:
                if act.type == discord.ActivityType.streaming:
                    stream_name = act.name
                    break
            cname = cname.replace('@@stream_name@@', stream_name)

        while '""' in cname and cname.count('""') % 2 == 0 and ':' in cname.split('""', 1)[1].split('""')[0]:
            b, m = cname.split('""', 1)
            m, e = m.split('""', 1)
            m, s = m.split(':', 1)
            s = s.strip()
            modes = m.split('+')
            ops = {
                'caps': str.upper,
                'upper': str.upper,
                'lower': str.lower,
                'title': utils.capitalize,
                'swap': str.swapcase,
                'rand': utils.random_case,
                'usd': utils.upsidedown,
                'acro': utils.acronym,
                'remshort': utils.remove_short_words,
                'spaces': utils.full_strip,
                'uwu': translate.uwu,
                'scaps': translate.small_caps,
                'bold': translate.bold,
                'italic': translate.italic,
                'bolditalic': translate.bolditalic,
                'script': translate.script,
                'boldscript': translate.boldscript,
                'fraktur': translate.fraktur,
                'boldfraktur': translate.boldfraktur,
                'double': translate.double,
                'sans': translate.sans,
                'boldsans': translate.boldsans,
                'italicsans': translate.italicsans,
                'bolditalicsans': translate.bolditalicsans,
                'mono': translate.mono,
            }
            for mode in modes:
                mode = mode.lower().strip()
                if mode in ops:
                    s = ops[mode](s)
                    continue
                if mode.endswith('w') and len(mode) <= 3:
                    try:
                        n = mode[:-1].strip()
                        n = int(n)
                    except ValueError:
                        pass
                    else:
                        s = utils.first_n_words(s, n)
            cname = b + s + e

        cname = cname.strip()[:100]  # Discord has a character limit of 100 for voice channel names

        if not cname:  # Can't have empty channel name
            cname = "-"

        if channel.id in cfg.ATTEMPTED_CHANNEL_NAMES:
            previously_unsuccessful_name = cfg.ATTEMPTED_CHANNEL_NAMES[channel.id]
        else:
            previously_unsuccessful_name = channel.name

        if cname != previously_unsuccessful_name and cname != channel.name:
            log("{0}  Renaming {1}  to  {2}".format(str(channel.id)[-4:], channel.name, cname), guild)
            try:
                await channel.edit(name=cname)
            except discord.errors.Forbidden:
                log("Cannot rename channel {}: Missing permissions".format(channel.id), guild)
                await blind_echo(":warning: **Error!** I don't have permission to rename channel `{}`{}".format(
                    channel.id, " in the \"{}\" category".format(channel.category) if channel.category else ""), guild)
            except discord.errors.HTTPException as e:
                log("Cannot rename channel {}: {}".format(channel.id, e.text), guild)

            if channel.name != cname:
                # Template/game/user name contains illegal characters, store attempted name for future comparison.
                cfg.ATTEMPTED_CHANNEL_NAMES[channel.id] = cname
            else:
                if channel.id in cfg.ATTEMPTED_CHANNEL_NAMES:
                    del cfg.ATTEMPTED_CHANNEL_NAMES[channel.id]

        return channel.name


@utils.func_timer()
def get_secondaries(guild, settings=None, include_jc=False):
    if not settings:
        settings = utils.get_serv_settings(guild)
    secondaries = []
    for p in settings['auto_channels']:
        for s, sv in settings['auto_channels'][p]['secondaries'].items():
            secondaries.append(s)
            if include_jc and 'jc' in sv:
                secondaries.append(sv['jc'])
    return secondaries


@utils.func_timer()
def get_join_channels(guild, settings=None):
    if not settings:
        settings = utils.get_serv_settings(guild)
    jcs = {}
    for p in settings['auto_channels']:
        for s, sv in settings['auto_channels'][p]['secondaries'].items():
            if 'jc' in sv:
                sv['vc'] = s
                jcs[sv['jc']] = sv
    return jcs


@utils.func_timer()
def get_voice_context_channel_ids(guild, settings=None):
    if not settings:
        settings = utils.get_serv_settings(guild)
    channel_ids = []
    for p in settings['auto_channels']:
        for s, sv in settings['auto_channels'][p]['secondaries'].items():
            if 'tc' in sv:
                channel_ids.append(sv['tc'])
    return channel_ids


@utils.func_timer()
async def create_primary(guild, cname, author):
    overwrites = {
        guild.me: discord.PermissionOverwrite(read_messages=True,
                                              connect=True,
                                              manage_channels=True,
                                              move_members=True)
    }
    c = await guild.create_voice_channel(cname, overwrites=overwrites)

    settings = utils.get_serv_settings(guild)
    settings['auto_channels'][c.id] = {"secondaries": {}}
    settings['server_contact'] = author.id
    utils.set_serv_settings(guild, settings)

    await server_log(
        guild,
        "🆕 {} (`{}`) created a new primary channel channel (`{}`)".format(
            user_hash(author), author.id, c.id
        ), 1, settings
    )

    return c


@utils.func_timer(2.5)
async def create_secondary(guild, primary, creator, private=False):
    # Create voice channel above/below primary one and return it

    settings = utils.get_serv_settings(guild)

    # Double check creator is still in primary in attempt to solve infinite creation bug.
    if creator not in primary.members:
        log("{} no longer in primary".format(creator.display_name), guild)
        return

    # Check we're allowed to make the channel
    if user_request_is_locked(creator):
        return
    elif not check_primary_permissions(primary, guild.me):
        lock_user_request(creator)
        log("{} ({}) tried creating a channel where I don't have permissions".format(creator.display_name,
                                                                                     creator.id), guild)
        msg = "{} ❌ You tried creating a channel where I don't have the right permissions.".format(creator.mention)
        server_contact = guild.get_member(settings['server_contact'])
        msg += "\n\nPlease make sure I have the following permissions"
        if primary.category:
            msg += " in the \"{}\" category:\n".format(primary.category.name)
        else:
            msg += ":\n"
        msg += "- **Manage Channel**\n"
        msg += "- **Read Text Channels & See Voice Channels**\n"
        msg += "- **Send Messages**\n"
        msg += "- **Connect** *(under voice channel permissions)*\n"
        msg += "- **Move members**\n\n"
        if server_contact is not None and server_contact != creator:
            msg += "If you are not an admin/manager of this server, "
            msg += "{} might be able to help you.\n".format(server_contact.mention)
        msg += "If you need any help, you can join my support server: <https://discord.gg/qhMrz6u>.\n\n"
        msg += "This message will repeat every 5 minutes if the problem is not resolved. "
        msg += "To stop this, either fix the issue or leave the voice channel causing the problem."
        await blind_echo(msg, guild)
        try:
            await creator.move_to(None)  # Kick them from voice channel
        except discord.errors.Forbidden:
            # If we can't create channels, we probably also don't have permission to kick people.
            pass
        return
    else:
        abuse_count = detect_abuse(creator)
        if abuse_count >= cfg.ABUSE_THRESHOLD:
            if abuse_count == cfg.ABUSE_THRESHOLD:
                log("{} ({}) is creating channels too quickly".format(creator.display_name, creator.id), guild)
                await dm_user(
                    creator,
                    ":warning: **Please slow down.** :warning:\n"
                    "You are trying to create voice channels in **{}** too quickly "
                    "and have been placed on cooldown for 15 seconds.\n"
                    "It's perfectly okay to stress test me initially, but continued abuse or any deliberate attempt at "
                    "sabotage may eventually result in you being blacklisted and ignored.".format(guild.name)
                )
                await server_log(
                    guild,
                    "⚠ {} (`{}`) tried creating channels too quickly and has entered cooldown".format(
                        user_hash(creator), creator.id
                    ), 1, settings
                )
            return

    lock_user_request(creator, offset=20)  # Add offset in case creating the channel takes more than 3s

    # Find what the channel position is supposed to be
    # Channel.position is unreliable, so we have to find it manually.
    c_position = 0
    voice_channels = [x for x in guild.channels if isinstance(x, type(primary))]
    voice_channels.sort(key=lambda ch: ch.position)
    above = True
    if ('above' in settings['auto_channels'][primary.id] and
            settings['auto_channels'][primary.id]['above'] is False):
        above = False
    c_position = primary.position
    if not above:
        secondaries = settings['auto_channels'][primary.id]['secondaries'].keys()
        c_position += 1 + len([v for v in voice_channels if v.id in secondaries and v.position > primary.position])

    # Copy stuff from primary channel
    user_limit = 0
    if primary.user_limit:
        user_limit = primary.user_limit
    elif 'limit' in settings['auto_channels'][primary.id]:
        user_limit = settings['auto_channels'][primary.id]['limit']
    bitrate = primary.bitrate
    try:
        bitrate = min(guild.bitrate_limit, settings['custom_bitrates'][str(creator.id)] * 1000)
    except KeyError:
        pass

    perms_source = (settings['auto_channels'][primary.id]['inheritperms']
                    if 'inheritperms' in settings['auto_channels'][primary.id]
                    else 'PRIMARY')
    overwrites = primary.overwrites
    if perms_source == 'CATEGORY':
        if primary.category:
            overwrites = primary.category.overwrites
    elif isinstance(perms_source, int):
        try:
            overwrites = guild.get_channel(perms_source).overwrites
        except (discord.errors.Forbidden, AttributeError):
            pass
    if private:
        k = guild.default_role
        v = overwrites[k] if k in overwrites else discord.PermissionOverwrite()
        v.update(connect=False)
        overwrites[k] = v
    k = guild.me
    v = overwrites[k] if k in overwrites else discord.PermissionOverwrite()
    v.update(read_messages=True, connect=True, manage_channels=True, move_members=True)
    overwrites[k] = v

    # Let there be sound
    try:
        c = await guild.create_voice_channel(
            "⌛",
            category=primary.category,
            bitrate=bitrate,
            user_limit=user_limit,
            overwrites=overwrites
        )
    except discord.errors.HTTPException as e:
        if "Maximum number of channels in category reached" in e.text:
            log("Failed to create channel for {}: Max channels reached".format(creator.display_name), guild)
            await dm_user(
                creator,
                ":warning: Sorry, I was unable to create a channel for you as the maximum number of channels in that "
                "category has been reached. Please let an admin of the server **{}** know about this issue so that "
                "they can make another category for voice channels.".format(esc_md(guild.name)))
            await creator.move_to(None)  # Kick them from voice channel
            lock_user_request(creator)
            return
        else:
            raise e
    log("{}  Creating channel for {}".format(str(c.id)[-4:], creator.display_name), guild)
    utils.permastore_secondary(c.id)
    lock_channel_request(c)
    settings = utils.get_serv_settings(guild)
    sv = {"creator": creator.id}
    if private:
        sv['priv'] = True
    settings['auto_channels'][primary.id]['secondaries'][c.id] = sv
    settings['left'] = False  # Just in case a returning guild's "on_guild_join" call wasn't caught.
    settings['last_activity'] = int(time())
    utils.set_serv_settings(guild, settings)

    try:
        await c.edit(position=c_position)
    except discord.errors.Forbidden:
        # No idea why it sometimes throws this, seems like a bug.
        # If it can create channels, it certainly has permission to move them.
        log("Warning: Unable to set channel position {}".format(c.id), guild)

    # Move user
    try:
        await creator.move_to(c)
    except discord.errors.HTTPException as e:
        log("Failed to move user {}: {}".format(creator.display_name, e.text), guild)
        lock_user_request(creator)
        return c

    lock_user_request(creator, 5)  # Lock again just to remove the 20s offset used earlier

    # Rename channel
    num_siblings = len([s for s in settings['auto_channels'][primary.id]['secondaries'] if s != c.id])
    name = await rename_channel(
        guild=guild,
        channel=c,
        settings=None,
        primary_id=primary.id,
        i=num_siblings,
        ignore_lock=True
    )

    # Logging
    log_msg = "✅ {} (`{}`) created \"**{}**\" (`{}`) using \"**{}**\" (`{}`)".format(
        user_hash(creator), creator.id,
        "None" if not name else esc_md(name), c.id,
        esc_md(primary.name), primary.id
    )
    if bitrate != primary.bitrate:
        log_msg += " [{}kbps]".format(round(bitrate / 1000))
    await server_log(guild, log_msg, 1, settings)

    # Text Channel
    settings = utils.get_serv_settings(guild)
    if 'text_channels' in settings and settings['text_channels'] and is_gold(guild):
        try:
            r = await guild.create_role(name="🎤🤖vc {}".format(c.id))
        except discord.errors.Forbidden:
            return c
        await creator.add_roles(r)
        overwrites = {
            guild.default_role: discord.PermissionOverwrite(read_messages=False),
            guild.me: discord.PermissionOverwrite(read_messages=True),
            r: discord.PermissionOverwrite(read_messages=True),
        }
        if 'stct' in settings:
            showto_r = guild.get_role(settings['stct'])
            if showto_r:
                overwrites[showto_r] = discord.PermissionOverwrite(read_messages=True)
        tc = await guild.create_text_channel(
            utils.nice_cname(settings['text_channel_name']) if 'text_channel_name' in settings else "voice context",
            category=primary.category,
            overwrites=overwrites,
            topic=(":eye: This channel is only visible to members of your voice channel, "
                   "and admins of this server. It will be deleted when everyone leaves. VC ID: {}".format(c.id)))
        settings = utils.get_serv_settings(guild)
        settings['auto_channels'][primary.id]['secondaries'][c.id]['tc'] = tc.id
        settings['auto_channels'][primary.id]['secondaries'][c.id]['tcr'] = r.id
        utils.set_serv_settings(guild, settings)

    if creator in c.members:
        unlock_channel_request(c)
    else:
        log("{}  Still trying to move {}".format(str(c.id)[-4:], creator.display_name), guild)
        lock_channel_request(c, 20)
        lock_user_request(creator, 20)

    return c


@utils.func_timer()
async def delete_secondary(guild, channel):
    if channel_is_requested(channel):
        return
    lock_channel_request(channel)

    log("{}  Deleting {}".format(str(channel.id)[-4:], channel.name), guild)
    cid = channel.id
    try:
        await channel.delete()
    except discord.errors.NotFound:
        pass
    except discord.errors.Forbidden:
        log("Forbidden to delete channel {} in guild {}".format(channel.id, guild.id), guild)
        await blind_echo(":warning: **Error!** I don't have permission to delete channel `{}`{}".format(
            channel.id, " in the \"{}\" category".format(channel.category) if channel.category else ""), guild)
        lock_channel_request(channel, 10)
    except Exception:
        log("Failed to delete channel {} in guild {}".format(channel.id, guild.id), guild)
        lock_channel_request(channel, 10)
        print(traceback.format_exc())
    else:
        settings = utils.get_serv_settings(guild)
        for p in settings['auto_channels']:
            tmp = settings['auto_channels'][p]['secondaries'].copy()
            for s, sv in tmp.items():
                if s == cid:
                    if 'jc' in sv:
                        jc = guild.get_channel(sv['jc'])
                        if jc:
                            try:
                                await jc.delete()
                            except discord.errors.NotFound:
                                # Small chance of channel disappearing before we can delete it
                                pass
                    if 'tc' in sv:
                        tc = guild.get_channel(sv['tc'])
                        if tc:
                            try:
                                await tc.delete()
                            except discord.errors.NotFound:
                                # Small chance of channel disappearing before we can delete it
                                pass
                    if 'tcr' in sv:
                        tcr = guild.get_role(sv['tcr'])
                        if tcr:
                            try:
                                await tcr.delete()
                            except discord.errors.NotFound:
                                # Small chance of role disappearing before we can delete it
                                pass
                    del settings['auto_channels'][p]['secondaries'][s]
        utils.set_serv_settings(guild, settings)

        if channel.id in cfg.ATTEMPTED_CHANNEL_NAMES:
            del cfg.ATTEMPTED_CHANNEL_NAMES[channel.id]

        unlock_channel_request(channel)

        await server_log(
            guild,
            "❌ \"**{}**\" (`{}`) was deleted".format(
                esc_md(channel.name), channel.id
            ), 2, settings
        )


@utils.func_timer()
async def remove_broken_channels(guild):
    voice_channels = [x for x in guild.channels if isinstance(x, discord.VoiceChannel)]
    for v in voice_channels:
        if v.name in ['⌛', '⚠'] and not channel_is_requested(v):
            if not v.members:
                lock_channel_request(v)
                try:
                    await v.delete()
                except discord.errors.Forbidden:
                    log("Forbidden to delete channel {} in guild {}".format(v.id, guild.id), guild)
                    await blind_echo(":warning: **Error!** I don't have permission to delete channel `{}`{}".format(
                        v.id, " in the \"{}\" category".format(v.category) if v.category else ""), guild)
                    lock_channel_request(v, 10)
                except discord.errors.NotFound:
                    log("Failed to delete channel {} in guild {} (NotFound)".format(v.id, guild.id), guild)
                    lock_channel_request(v, 10)
                except Exception:
                    log("Failed to delete channel {} in guild {}".format(v.id, guild.id), guild)
                    lock_channel_request(v, 10)
                    print(traceback.format_exc())
                unlock_channel_request(v)

    if is_gold(guild):
        text_channels = [x for x in guild.channels if isinstance(x, discord.TextChannel)]
        for c in text_channels:
            front = (":eye: This channel is only visible to members of your voice channel, "
                     "and admins of this server. It will be deleted when everyone leaves. VC ID: ")
            if c.topic and c.topic.startswith(front):
                try:
                    vcid = int(c.topic.split(front)[1])
                except ValueError:
                    continue
                vc = guild.get_channel(vcid)
                if not vc:
                    try:
                        await c.delete()
                    except discord.errors.NotFound:
                        pass

    for r in guild.roles:
        front = "🎤🤖vc "
        if r.name.startswith("🎤🤖vc "):
            try:
                vcid = int(r.name.split(front)[1])
            except ValueError:
                continue
            vc = guild.get_channel(vcid)
            if not vc:
                try:
                    await r.delete()
                except discord.errors.NotFound:
                    pass
