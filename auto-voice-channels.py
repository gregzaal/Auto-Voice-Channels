import asyncio
import concurrent.futures
import os
import logging
import traceback
import subprocess
import sys
from copy import deepcopy
from datetime import datetime
from time import time

import cfg
from commands import admin_commands
import commands
import discord
import psutil
import pytz
import translate
import utils
import functions as func
from functions import log, echo
from discord.ext.tasks import loop

intents = discord.Intents.default()
intents.members = True
intents.presences = True
intents.typing = False
intents.webhooks = False
intents.invites = False
intents.integrations = False

try:
    import uvloop

    uvloop.install()
except ImportError:  # Pragma no cover
    pass


logging.basicConfig(level=logging.WARNING)
ADMIN_CHANNEL = None
ADMIN = None

POOL = concurrent.futures.ThreadPoolExecutor()

DEV_BOT = cfg.CONFIG['DEV'] if 'DEV' in cfg.CONFIG else False
GOLD_BOT = False
NUM_SHARDS = cfg.CONFIG['num_shards'] if 'num_shards' in cfg.CONFIG else 0

if DEV_BOT:
    print("DEV BOT")
    TOKEN = cfg.CONFIG['token_dev']
else:
    TOKEN = cfg.CONFIG['token']
try:
    sid = int(sys.argv[1])
    if str(sid) in cfg.CONFIG["sapphires"]:
        cfg.SAPPHIRE_ID = sid
        TOKEN = cfg.CONFIG["sapphires"][str(sid)]['token']
        NUM_SHARDS = 1
    elif 'gold_id' in cfg.CONFIG and sid == 6666:
        GOLD_BOT = True
        TOKEN = cfg.CONFIG["token_gold"]
        NUM_SHARDS = 1
    else:
        print("NO SAPPHIRE WITH ID " + str(sid))
        sys.exit()
except IndexError:
    pass
except ValueError:
    pass

LAST_COMMIT = "UNKNOWN"
try:
    LAST_COMMIT = \
        subprocess.check_output(['git', 'log', '-1']).decode('ascii').strip().split('\n\n    ', 1)[
            1]
except:
    print("Warning: Failed to get last commit log")
    pass

utils.clean_permastore()
utils.update_server_location()


class LoopChecks:
    def __init__(self, client, tick):
        self._client = client
        self._time = time()
        self._loop = asyncio.get_event_loop()
        self._tick = tick

    async def waiting_loop(self):
        print("Starting Waiting Loop")
        while True:
            tmp = {}
            for c, v in cfg.CURRENT_REQUESTS.items():

                if self._time - v < 5:
                    tmp[c] = v
            cfg.CURRENT_REQUESTS = tmp
            await asyncio.sleep(self._tick)

    async def active_loop(self):
        print("Starting Active Loop")
        while True:
            tmp = {}
            for u, v in cfg.USER_REQUESTS.items():

                if self._time - v < 15:
                    tmp[u] = v
                else:
                    if u in cfg.USER_ABUSE_EVENTS:
                        del (cfg.USER_ABUSE_EVENTS[u])
            cfg.USER_REQUESTS = tmp
            await asyncio.sleep(self._tick)

    async def other_loops(self):
        print("Starting Other Loops")
        while True:
            tmp = {}
            for e, v in cfg.ERROR_MESSAGES.items():
                if self._time - v < (60 * 5):  # Forget messages older than 5 minutes
                    tmp[e] = v
            cfg.ERROR_MESSAGES = tmp

            tmp = {}
            for e, v in cfg.DM_ERROR_MESSAGES.items():
                if self._time - v < 15:
                    tmp[e] = v
            cfg.DM_ERROR_MESSAGES = tmp
            await asyncio.sleep(self._tick)

    async def timer(self):
        print("Starting Timer")
        while True:
            self._time = time()
            await asyncio.sleep(self._tick)

    def start_loops(self):
        self._loop.create_task(self.timer())
        self._loop.create_task(self.waiting_loop())
        self._loop.create_task(self.active_loop())
        self._loop.create_task(self.other_loops())


def cleanup(client, tick_):
    # TODO probably possible to run into race conditions

    start_time = time()

    LoopSystem = LoopChecks(client=client, tick=tick_)
    LoopSystem.start_loops()

    async def first_start(client):
        global ADMIN_CHANNEL
        global ADMIN

        while not client.is_ready():
            await asyncio.sleep(1)
        if not cfg.FIRST_RUN_COMPLETE:
            cfg.FIRST_RUN_COMPLETE = True
            guilds = func.get_guilds(client)
            if guilds:
                text = 'vc/help'
                if len(guilds) == 1 and guilds[0].id in cfg.PREFIXES:
                    text = cfg.PREFIXES[guilds[0].id] + 'help'
            else:
                text = "🚧No guilds🚧"
            await client.change_presence(
                activity=discord.Activity(name=text, type=discord.ActivityType.watching))

            if 'admin_channel' in cfg.CONFIG:
                ADMIN_CHANNEL = client.get_channel(cfg.CONFIG['admin_channel'])

        if ADMIN is None:
            ADMIN = await client.fetch_user(cfg.CONFIG['admin_id'])

    asyncio.get_event_loop().create_task(first_start(client))

    end_time = time()
    fn_name = "cleanup"
    cfg.TIMINGS[fn_name] = end_time - start_time


# @loop(seconds=cfg.CONFIG['loop_interval'])
@loop(minutes=10)
async def main_loop(client):
    await client.wait_until_ready()

    main_loop.last_run = datetime.now(pytz.utc)
    start_time = time()
    if client.is_ready():
        guilds = await asyncio.get_event_loop().run_in_executor(
            POOL,
            func.get_guilds,
            client
        )
        for guild in guilds:
            settings = utils.get_serv_settings(guild)
            if settings['enabled'] and settings['auto_channels']:
                await check_all_channels(guild, settings)
        end_time = time()
        fn_name = "main_loop"
        cfg.TIMINGS[fn_name] = end_time - start_time
        if cfg.TIMINGS[fn_name] > 20:
            await func.log_timings(client, fn_name)

        # Check for new patrons using patron role in support server
        if cfg.SAPPHIRE_ID is None:
            try:
                num_patrons = len(
                    client.get_guild(601015720200896512).get_role(606482184043364373).members)
            except AttributeError:
                pass
            else:
                if cfg.NUM_PATRONS != num_patrons:
                    if cfg.NUM_PATRONS != -1:  # Skip first run, since patrons are fetched on startup already.
                        await func.check_patreon(force_update=(not DEV_BOT), client=client)
                    cfg.NUM_PATRONS = num_patrons


@loop(seconds=cfg.CONFIG['loop_interval'])
async def creation_loop(client):
    await client.wait_until_ready()

    creation_loop.last_run = datetime.now(pytz.utc)

    @utils.func_timer()
    async def check_create(guild, settings):
        for pid in settings['auto_channels']:
            p = client.get_channel(int(pid))
            if p is not None:
                users_waiting = [m for m in p.members if not func.user_request_is_locked(m)]
                for u in users_waiting:
                    await func.create_secondary(guild, p, u)

    start_time = time()
    if client.is_ready():
        guilds = await asyncio.get_event_loop().run_in_executor(
            POOL,
            func.get_guilds,
            client
        )
        for guild in guilds:
            settings = utils.get_serv_settings(guild)
            if settings['enabled'] and settings['auto_channels']:
                await check_create(guild, settings)
        end_time = time()
        fn_name = "creation_loop"
        cfg.TIMINGS[fn_name] = end_time - start_time
        if cfg.TIMINGS[fn_name] > 20:
            await func.log_timings(client, fn_name)


@loop(seconds=cfg.CONFIG['loop_interval'] * 2)
async def deletion_loop(client):
    await client.wait_until_ready()

    deletion_loop.last_run = datetime.now(pytz.utc)

    @utils.func_timer()
    async def check_empty(guild, settings):
        # Delete empty secondaries, in case they didn't get caught somehow (e.g. errors, downtime)
        secondaries = func.get_secondaries(guild, settings)
        voice_channels = [x for x in guild.channels if isinstance(x, discord.VoiceChannel)]
        for v in voice_channels:
            if v.name != "⌛":  # Ignore secondary channels that are currently being created
                if v.id in secondaries:
                    if not v.members:
                        await func.delete_secondary(guild, v)

    start_time = time()
    if client.is_ready():
        guilds = await asyncio.get_event_loop().run_in_executor(
            POOL,
            func.get_guilds,
            client
        )
        for guild in guilds:
            settings = utils.get_serv_settings(guild)
            if settings['enabled'] and settings['auto_channels']:
                await check_empty(guild, settings)
                await func.remove_broken_channels(guild)
        end_time = time()
        fn_name = "deletion_loop"
        cfg.TIMINGS[fn_name] = end_time - start_time
        if cfg.TIMINGS[fn_name] > 20:
            await func.log_timings(client, fn_name)


def for_looper(client):
    for guild in func.get_guilds(client):
        settings = utils.get_serv_settings(guild)  # Need fresh in case some were deleted
        dead_secondaries = []
        for p in settings['auto_channels']:
            for sid, sv in settings['auto_channels'][p]['secondaries'].items():
                s = client.get_channel(sid)
                if s is None:
                    dying = sv['dying'] + 1 if 'dying' in sv else 1
                    settings['auto_channels'][p]['secondaries'][sid]['dying'] = dying
                    cfg.GUILD_SETTINGS[
                        guild.id] = settings  # Temporarily settings, no need to write to disk.
                    log("{} is dead ({})".format(sid, dying), guild)
                    if dying >= 3:
                        dead_secondaries.append(sid)
                else:
                    if 'dying' in sv:
                        settings['auto_channels'][p]['secondaries'][sid]['dying'] = 0
                        cfg.GUILD_SETTINGS[
                            guild.id] = settings  # Temporarily settings, no need to write to disk.

        if dead_secondaries:
            for p, pv in settings['auto_channels'].items():
                tmp = {}
                for s, sv in pv['secondaries'].items():
                    if s not in dead_secondaries:
                        tmp[s] = sv
                settings['auto_channels'][p]['secondaries'] = tmp

            utils.set_serv_settings(guild, settings)

            for s in dead_secondaries:
                if s in cfg.ATTEMPTED_CHANNEL_NAMES:
                    del cfg.ATTEMPTED_CHANNEL_NAMES[s]


@loop(minutes=2)
async def check_dead(client):
    await client.wait_until_ready()

    check_dead.last_run = datetime.now(pytz.utc)

    start_time = time()
    if client.is_ready():
        with concurrent.futures.ThreadPoolExecutor() as pool:
            await client.loop.run_in_executor(pool, for_looper, client)
        end_time = time()
        fn_name = "check_dead"
        cfg.TIMINGS[fn_name] = end_time - start_time
        if cfg.TIMINGS[fn_name] > 20:
            await func.log_timings(client, fn_name)


@loop(seconds=2)
async def check_votekicks(client):
    await client.wait_until_ready()

    check_votekicks.last_run = datetime.now(pytz.utc)
    start_time = time()
    if client.is_ready():
        to_remove = []
        votekicks = list(cfg.VOTEKICKS.keys())
        for mid in votekicks:
            try:
                vk = cfg.VOTEKICKS[mid]
            except KeyError:
                print("Ignoring error:")
                traceback.print_exc()
                continue
            guild = vk['message'].guild
            guilds = func.get_guilds(client)
            if guild not in guilds:
                return

            in_favor = len(vk['in_favor'])
            if in_favor >= vk['required_votes']:
                to_remove.append(mid)

                try:
                    await vk['offender'].move_to(None)  # Kick
                except Exception as e:
                    try:
                        await vk['message'].edit(
                            content="‼ **Votekick** failed - A `{}` error was encountered.".format(
                                type(e).__name__))
                    except discord.errors.NotFound:
                        continue
                    continue

                banned = True
                try:
                    await vk['voice_channel'].set_permissions(vk['offender'], connect=False)
                except discord.errors.Forbidden:
                    banned = False

                try:
                    await vk['message'].edit(content=(
                        "‼ **Votekick** ‼\n"
                        "{} was **kicked** from {}'s channel{}.{}".format(
                            vk['offender'].mention, vk['initiator'].mention,
                            ((", but could not be banned from the channel as I don't have the"
                              "*Manage     Roles* permission.") if not banned else ""),
                            ("\nReason: **{}**".format(vk['reason']) if vk['reason'] else ""))
                    ))
                except discord.errors.NotFound:
                    continue

                await func.server_log(
                    guild,
                    "👢 {} (`{}`) has been **kicked** from {}'s channel.".format(
                        func.user_hash(vk['offender']), vk['offender'].id, vk['initiator']
                    ), 1, utils.get_serv_settings(guild)
                )
            elif time() > vk['end_time'] + 5:
                to_remove.append(mid)

                try:
                    await vk['message'].edit(
                        content="‼ **Votekick** timed out: Insufficient votes received "
                                "({0}/{1}), required: {2}/{1}.".format(in_favor,
                                                                       len(vk['participants']) + 1,
                                                                       vk['required_votes']))
                except discord.errors.NotFound:
                    continue
        for mid in to_remove:
            del cfg.VOTEKICKS[mid]

        end_time = time()
        fn_name = "check_votekicks"
        cfg.TIMINGS[fn_name] = end_time - start_time
        if cfg.TIMINGS[fn_name] > 20:
            await func.log_timings(client, fn_name)


@loop(seconds=3)
async def create_join_channels(client):
    await client.wait_until_ready()

    create_join_channels.last_run = datetime.now(pytz.utc)
    start_time = time()
    if not client.is_ready():
        return

    to_remove = []
    priv_channels = list(cfg.PRIV_CHANNELS.keys())
    for pc in priv_channels:
        try:
            pcv = cfg.PRIV_CHANNELS[pc]
        except KeyError:
            print("Ignoring error:")
            traceback.print_exc()
            continue

        if 'request_time' in pcv and time() - pcv['request_time'] > 120:
            # Unable to create join channel for 120s
            to_remove.append(pc)
            try:
                await pcv['text_channel'].send(
                    ":warning: {} For some reason I was unable to create your \"⇩ Join\" channel, please try again later. "
                    "Your channel is still private, but there's now no way for anyone to join you. "
                    "Use `{}public` to make it public again."
                    "".format(pcv['creator'].mention, pcv['prefix']))
                log("Failed to create join-channel, timed out.")
            except (discord.errors.Forbidden, discord.errors.NotFound):
                log("Failed to create join-channel, timed out - and failed to send message.")
            continue

        guild = client.get_guild(pcv['guild_id'])
        if guild not in func.get_guilds(client):
            continue
        settings = utils.get_serv_settings(guild)
        settings_copy = deepcopy(settings)
        for p, pv in settings_copy['auto_channels'].items():
            for s, sv in pv['secondaries'].items():
                if 'priv' in sv and 'jc' not in sv:
                    creator = pcv['creator'].display_name
                    vc = pcv['voice_channel']

                    overwrites = vc.overwrites
                    k = guild.default_role
                    v = overwrites[k] if k in overwrites else discord.PermissionOverwrite()
                    v.update(connect=True)
                    overwrites[k] = v

                    try:
                        jc = await guild.create_voice_channel("⇩ Join {}".format(creator),
                                                              # TODO creator can change
                                                              category=vc.category,
                                                              overwrites=overwrites)
                    except discord.errors.Forbidden:
                        to_remove.append(pc)
                        try:
                            await pcv['text_channel'].send(
                                ":warning: {} I don't have permission to make the \"⇩ Join\" channel for you anymore."
                                "".format(pcv['creator'].mention))
                        except:
                            log("Failed to create join-channel, and failed to notify {}".format(
                                creator))
                            break
                        break
                    except discord.errors.HTTPException as e:
                        to_remove.append(pc)
                        try:
                            await pcv['text_channel'].send(
                                ":warning: {} I couldn't create the \"⇩ Join\" channel for you, Discord says: {}".format(pcv['creator'].mention, e.text))
                        except:
                            log("Failed to create join-channel, and failed to notify {}".format(
                                creator))
                            break
                        break


                    utils.permastore_secondary(jc.id)

                    try:
                        settings['auto_channels'][p]['secondaries'][s]['jc'] = jc.id
                    except KeyError:
                        to_remove.append(pc)
                        break

                    utils.set_serv_settings(guild, settings)
                    to_remove.append(pc)
                    try:
                        await jc.move(category=vc.category, before=vc)
                    except discord.errors.Forbidden:
                        # Harmless error, no idea why it sometimes throws this, seems like a bug.
                        pass
                    except discord.errors.InvalidArgument as e:
                        try:
                            await pcv['text_channel'].send(
                                ":warning: {} I couldn't move the \"⇩ Join\" channel to the right position, but it should still work. Discord says: {}".format(pcv['creator'].mention, e.text))
                        except:
                            log("Failed to create join-channel, and failed to notify {}".format(
                                creator))
                            break
                    break

                # give the event loop some more control
                await asyncio.sleep(0.5)
            await asyncio.sleep(0.5)
        await asyncio.sleep(0.5)

    for i in to_remove:
        try:
            del cfg.PRIV_CHANNELS[i]
        except KeyError:
            # Already deleted somehow.
            print("Ignoring error:")
            traceback.print_exc()
            pass

    end_time = time()
    fn_name = "create_join_channels"
    cfg.TIMINGS[fn_name] = end_time - start_time
    if cfg.TIMINGS[fn_name] > 10:
        await func.log_timings(client, fn_name)


@loop(minutes=3)
async def update_seed(client):
    await client.wait_until_ready()

    update_seed.last_run = datetime.now(pytz.utc)
    if client.is_ready():
        cfg.SEED = int(time())


@loop(minutes=5)
async def dynamic_tickrate(client):
    await client.wait_until_ready()

    dynamic_tickrate.last_run = datetime.now(pytz.utc)
    start_time = time()
    if client.is_ready():
        current_channels = utils.num_active_channels(func.get_guilds(client))
        new_tickrate = current_channels / 7
        new_tickrate = max(10, min(100, new_tickrate))
        new_seed_interval = current_channels / 45
        new_seed_interval = max(10, min(15, new_seed_interval))
        if cfg.SAPPHIRE_ID is None:
            print("New tickrate is {0:.1f}s, seed interval is {1:.2f}m".format(new_tickrate,
                                                                               new_seed_interval))
        main_loop.change_interval(seconds=max(301, new_tickrate))
        creation_loop.change_interval(seconds=new_tickrate)
        deletion_loop.change_interval(seconds=new_tickrate * 2)
        update_seed.change_interval(minutes=new_seed_interval)
        cfg.TICK_RATE = new_tickrate

        end_time = time()
        fn_name = "dynamic_tickrate"
        cfg.TIMINGS[fn_name] = end_time - start_time
        if cfg.TIMINGS[fn_name] > 20:
            await func.log_timings(client, fn_name)


def get_potentials():
    with open(os.path.join(cfg.SCRIPT_DIR, "secondaries.txt"), 'r') as f:
        potentials = f.read()
    return potentials


@loop(minutes=5.22)
async def lingering_secondaries(client):
    await client.wait_until_ready()

    lingering_secondaries.last_run = datetime.now(pytz.utc)
    start_time = time()
    if client.is_ready():
        potentials = None
        with concurrent.futures.ThreadPoolExecutor() as pool:
            potentials = await client.loop.run_in_executor(pool, get_potentials)
        potentials = potentials.split('\n')
        if potentials:
            # Sets apparently give better performance. Discard all but last 10k.
            potentials = set(potentials[-10000:])
            for guild in func.get_guilds(client):
                settings = utils.get_serv_settings(guild)
                if not settings['enabled'] or not settings['auto_channels']:
                    continue
                secondaries = func.get_secondaries(guild, settings=settings, include_jc=True)
                voice_channels = [x for x in guild.channels if isinstance(x, discord.VoiceChannel)]
                for v in voice_channels:
                    if v.id not in secondaries and str(
                            v.id) in potentials and not func.channel_is_requested(v):
                        if v.name not in ['⌛', '⚠']:
                            try:
                                await v.edit(name='⚠')
                                log("Remembering channel {}".format(v.id), guild)
                                await func.admin_log(
                                    "⚠ Remembering channel `{}` in guild **{}**".format(v.id,
                                                                                        guild.name),
                                    client
                                )
                            except discord.errors.NotFound:
                                pass
                            except Exception:
                                traceback.print_exc()

                    await asyncio.sleep(0)
                await asyncio.sleep(0)

        end_time = time()
        fn_name = "lingering_secondaries"
        cfg.TIMINGS[fn_name] = end_time - start_time
        if cfg.TIMINGS[fn_name] > 5:
            await func.log_timings(client, fn_name)


@loop(hours=2.4)
async def analytics(client):
    await client.wait_until_ready()

    analytics.last_run = datetime.now(pytz.utc)
    start_time = time()
    if client.is_ready() and cfg.SAPPHIRE_ID is None:
        fp = os.path.join(cfg.SCRIPT_DIR, "analytics.json")
        guilds = func.get_guilds(client)
        if not os.path.exists(fp):
            data = {}
        else:
            data = utils.read_json(fp)
        data[datetime.now(pytz.timezone(cfg.CONFIG['log_timezone'])).strftime("%Y-%m-%d %H:%M")] = {
            'nc': utils.num_active_channels(guilds),
            'tt': round(cfg.TICK_TIME, 2),
            'tr': main_loop.seconds,
            'ng': len(guilds),
            'm': round(psutil.virtual_memory().used / 1024 / 1024 / 1024, 2),
        }
        with concurrent.futures.ThreadPoolExecutor() as pool:
            await client.loop.run_in_executor(
                pool, utils.write_json, fp, data)
        end_time = time()
        fn_name = "analytics"
        cfg.TIMINGS[fn_name] = end_time - start_time
        if cfg.TIMINGS[fn_name] > 10:
            await func.log_timings(client, fn_name)


@loop(minutes=2)
async def update_status(client):
    await client.wait_until_ready()

    update_status.last_run = datetime.now(pytz.utc)
    if client.is_ready():
        guilds = func.get_guilds(client)
        if guilds:
            prefix = 'vc/'
            if len(guilds) == 1 and guilds[0].id in cfg.PREFIXES:
                prefix = cfg.PREFIXES[guilds[0].id]
            nc = utils.num_active_channels(guilds)
            text = "{}help | {} channel{}".format(prefix, nc, ("s" if nc != 1 else ""))
        else:
            text = "🚧No guilds🚧"

        old_text = ""
        try:
            old_text = client.guilds[0].me.activity.name
        except (IndexError, AttributeError, TypeError):
            pass
        if text != old_text:
            try:
                await client.change_presence(
                    activity=discord.Activity(name=text, type=discord.ActivityType.watching))
                log("Changing status to: {}".format(text.replace(' ', ' ')))
            except Exception as e:
                log("Failed to update status: {}".format(type(e).__name__))


@loop(hours=3)
async def check_patreon():
    # Will run at startup too, since it doesn't have to wait for client.is_ready
    await func.check_patreon(force_update=cfg.SAPPHIRE_ID in [None, 0] and not DEV_BOT)


loops = {  # loops with client as only arg - passed to admin_commands's `loop` cmd
    'main_loop': main_loop,
    'deletion_loop': deletion_loop,
    'check_dead': check_dead,
    'check_votekicks': check_votekicks,
    'create_join_channels': create_join_channels,
    'update_seed': update_seed,
    'dynamic_tickrate': dynamic_tickrate,
    'lingering_secondaries': lingering_secondaries,
    'analytics': analytics,
    'update_status': update_status,
}
if 'disable_creation_loop' not in cfg.CONFIG or not cfg.CONFIG['disable_creation_loop']:
    loops['creation_loop'] = creation_loop


async def check_all_channels(guild, settings):
    @utils.func_timer()
    async def check_rename(guild, settings):
        # Update secondary channel names
        settings = utils.get_serv_settings(guild)  # Need fresh in case some were deleted
        templates = {'0': 0}  # Initialize with 0's to prevent checking again if empty
        for p in settings['auto_channels']:
            secondaries = []
            for sid, sv in settings['auto_channels'][p]['secondaries'].items():
                s = client.get_channel(sid)
                if s is not None:
                    secondaries.append(s)
                    if "template" in settings['auto_channels'][p]:
                        templates[s.id] = settings['auto_channels'][p]['template']
                    if "name" in sv:
                        templates[s.id] = sv['name']
                await asyncio.sleep(0)
            await asyncio.sleep(0)

            secondaries = sorted(secondaries, key=lambda x: discord.utils.snowflake_time(x.id))
            for i, s in enumerate(secondaries):
                await func.rename_channel(guild=guild,
                                          channel=s,
                                          settings=settings,
                                          primary_id=None,
                                          templates=templates,
                                          i=i)
            await asyncio.sleep(0)

    if guild is None or guild.name is None:
        # Weird ghostly disconnect where things that shouldn't be possible happen.
        if not cfg.DISCONNECTED:
            cfg.DISCONNECTED = True
            print("There's something strange in the neighborhood.")
            await func.admin_log("Disconnecting ⁉", client, important=True)
        return
    cfg.DISCONNECTED = False

    timings = {}

    try:
        await check_rename(guild, settings)

    except Exception:
        traceback.print_exc()

    return timings


class MyClient(discord.AutoShardedClient):

    def __init__(self, *args, **kwargs):
        super().__init__(intents=intents, *args, **kwargs)
        self.ready_once = False

    async def start_chunking(self):
        self.ready_once = True
        for guild in self.guilds:
            await guild.chunk()
            await asyncio.sleep(0.1)

    async def on_shard_ready(self, _):
        await self.on_ready()

    async def on_ready(self):
        if self.ready_once:
            return

        asyncio.create_task(self.start_chunking())

        print('=' * 24)
        curtime = datetime.now(pytz.timezone(cfg.CONFIG['log_timezone'])).strftime("%Y-%m-%d %H:%M")
        print(curtime)
        print('Logged in as')
        print(self.user.name)
        print(self.user.id)
        if cfg.SAPPHIRE_ID is not None:
            print("Sapphire:", cfg.SAPPHIRE_ID)
        print("discordpy version: {}".format(discord.__version__))
        print('-' * 24)

        shards = {}
        for g in func.get_guilds(self):
            if g.shard_id in shards:
                shards[g.shard_id] += 1
            else:
                shards[g.shard_id] = 1
            settings = utils.get_serv_settings(g)
            if 'prefix' in settings:
                cfg.PREFIXES[g.id] = settings['prefix']
        print("Shards:", len(shards))
        for s in shards:
            print("s{}: {} guilds".format(s, shards[s]))
        print('=' * 24)

        if 'disable_ready_message' in cfg.CONFIG and cfg.CONFIG['disable_ready_message']:
            log("READY")
        else:
            await func.admin_log("🟥🟧🟨🟩   **Ready**   🟩🟨🟧🟥", self)


heartbeat_timeout = cfg.CONFIG['heartbeat_timeout'] if 'heartbeat_timeout' in cfg.CONFIG else 60
if NUM_SHARDS > 1:
    print("wew")
    client = MyClient(
        shard_count=NUM_SHARDS,
        heartbeat_timeout=heartbeat_timeout,
        chunk_guilds_at_startup=False,
    )
else:
    client = MyClient(
        heartbeat_timeout=heartbeat_timeout,
        chunk_guilds_at_startup=False,
    )


async def reload_modules(m):
    try:
        if m:
            commands.reload_command(m)
        from importlib import reload
        reload(commands)
        reload(utils)
        reload(func)
        reload(translate)
        cfg.CONFIG = utils.get_config()
        return True
    except:
        await func.admin_log(traceback.format_exc(), client)
        return False


# ----- COMMANDS -----
@client.event
async def on_message(message):
    if not client.is_ready():
        return

    if message.author.bot:
        # Don't respond to self or bots
        return

    guilds = func.get_guilds(client)

    admin = ADMIN
    admin_channels = []
    if admin is not None:
        admin_channels = [admin.dm_channel]
    if 'admin_channel' in cfg.CONFIG and ADMIN_CHANNEL is not None:
        admin_channels.append(ADMIN_CHANNEL)
    if message.channel in admin_channels:
        split = message.content.split(' ')
        cmd = split[0].split('\n')[0].lower()
        params_str = message.content[len(cmd):].strip()
        params = params_str.split(' ')

        if cmd == 'reload':
            m = utils.strip_quotes(params_str)
            success = await reload_modules(m)
            await func.react(message, '✅' if success else '❌')
        else:
            ctx = {
                'client': client,
                'admin': admin,
                'message': message,
                'params': params,
                'params_str': params_str,
                'guilds': guilds,
                'LAST_COMMIT': LAST_COMMIT,
                'loops': loops,
            }
            await admin_commands.admin_command(cmd, ctx)
        return

    if not message.guild:  # DM
        if 'help' in message.content and len(message.content) <= len("@Auto Voice Channels help"):
            await message.channel.send("Sorry I don't respond to commands in DMs, "
                                       "you need to type the commands in a channel in your server.\n"
                                       "If you've tried that already, then make sure I have the right permissions "
                                       "to see and reply to your commands in that channel.")
        elif message.content.lower().startswith("power-overwhelming"):
            channel = message.channel
            params_str = message.content[len("power-overwhelming"):].strip()
            if not params_str:
                await channel.send("You need to specify a guild ID. "
                                   "Try typing `who am I` to get a list of guilds we're both in")
                return
            auth_guilds = params_str.replace(' ', '\n').split('\n')
            for auth_guild in auth_guilds:
                try:
                    g = client.get_guild(int(auth_guild))
                    if g is None:
                        await channel.send("`{}` is not a guild I know about, "
                                           "maybe you need to invite me there first?".format(auth_guild))
                        return
                except ValueError:
                    await channel.send("`{}` is not a valid guild ID, try typing "
                                       "`who am I` to get a list of guilds we're both in.".format(auth_guild))
                    return
                except Exception as e:
                    error_text = "Auth Error `{}`\nUser `{}`\nCMD `{}`".format(type(e).__name__,
                                                                               message.author.id,
                                                                               message.content)
                    await func.admin_log(error_text, ctx['client'])
                    log(error_text)
                    error_text = traceback.format_exc()
                    await func.admin_log(error_text, ctx['client'])
                    log(error_text)
                    return False, ("A `{}` error occured :(\n"
                                   "An admin has been notified and will be in touch.\n"
                                   "In the meantime, try asking for help in the support server: "
                                   "https://discord.gg/qhMrz6u".format(type(e).__name__))

            ctx = {
                'message': message,
                'channel': channel,
                'client': client,
            }
            auth_guilds = [int(g) for g in auth_guilds]
            success, response = await func.power_overwhelming(ctx, auth_guilds)

            if success or response != "NO RESPONSE":
                log("DM CMD {}: {}".format("Y" if success else "F", message.content))

            if success:
                if response:
                    if response != "NO RESPONSE":
                        await echo(response, channel, message.author)
                else:
                    await func.react(message, '✅')
            else:
                if response != "NO RESPONSE":
                    await func.react(message, '❌')
                    if response:
                        await echo(response, channel, message.author)
        elif message.content.lower() in ["who am i", "who am i?"]:
            in_guilds = []
            for g in client.guilds:
                if g.get_member(message.author.id):
                    in_guilds.append("`{}` **{}**".format(g.id, g.name))
            if in_guilds:
                await message.channel.send(
                    "We're both in the following guilds:\n{}".format('\n'.join(in_guilds)))
            else:
                await message.channel.send("I'm not in any of the same guilds as you.")
        else:
            await admin_channels[-1].send(embed=discord.Embed(
                title="DM from **{}** [`{}`]:".format(message.author.name, message.author.id),
                description=message.content
            ))
        return

    if message.guild not in guilds:
        return

    prefix_m = message.guild.me.mention
    prefix_mx = "<@!" + prefix_m[2:]
    if message.guild.id in cfg.PREFIXES:
        prefix_p = cfg.PREFIXES[message.guild.id]
    else:
        prefix_p = 'vc/'

    prefix = None
    if message.content.startswith(prefix_m):
        prefix = prefix_m
        print_prefix = "@{} ".format(message.guild.me.display_name)
    elif message.content.startswith(prefix_mx):
        prefix = prefix_mx
        print_prefix = "@{} ".format(message.guild.me.display_name)
    elif message.content.lower().startswith(prefix_p.lower()):
        prefix = prefix_p
        print_prefix = prefix_p

    # Commands
    if prefix:
        msg = message.content[len(prefix):].strip()  # Remove prefix
        split = msg.split(' ')
        cmd = split[0].lower()
        params = split[1:]
        params_str = ' '.join(params)
        clean_paramstr = ' '.join(message.clean_content[len(prefix):].strip().split(' ')[1:])

        guild = message.guild
        channel = message.channel

        settings = utils.get_serv_settings(guild)
        if channel.id not in func.get_voice_context_channel_ids(guild, settings):
            settings['last_channel'] = channel.id
            utils.set_serv_settings(guild, settings)

        ctx = {
            'client': client,
            'guild': guild,
            'prefix': prefix,
            'print_prefix': print_prefix,
            'prefix_p': prefix_p,
            'command': cmd,
            'gold': func.is_gold(guild),
            'sapphire': func.is_sapphire(guild),
            'settings': settings,
            'message': message,
            'channel': channel,
            'clean_paramstr': clean_paramstr,
        }

        # Restricted commands
        perms = message.author.permissions_in(channel)
        perms_required = [
            perms.manage_channels,
            perms.manage_roles,
        ]
        ctx['admin'] = all(perms_required)

        success, response = await commands.run(cmd, ctx, params)

        if success or response != "NO RESPONSE":
            log("CMD {}: {}".format("Y" if success else "F", msg), guild)

        if success:
            if response:
                if response != "NO RESPONSE":
                    await echo(response, channel, message.author)
            else:
                await func.react(message, '✅')
        else:
            if response != "NO RESPONSE":
                await func.react(message, '❌')
                if response:
                    await echo(response, channel, message.author)


@client.event
async def on_reaction_add(reaction, user):
    if not client.is_ready():
        return

    if user.bot:
        return

    guild = reaction.message.guild
    guilds = func.get_guilds(client)
    if guild not in guilds:
        return

    if reaction.message.id in cfg.VOTEKICKS:
        if reaction.emoji == '✅':
            vk = cfg.VOTEKICKS[reaction.message.id]
            if time() < vk['end_time']:
                if user not in vk['in_favor'] and user in vk['participants']:
                    vk['in_favor'].append(user)
                    log("{} voted to kick {}".format(user.display_name,
                                                     vk['offender'].display_name), guild)
        return

    to_delete = []
    joins_in_progress = list(cfg.JOINS_IN_PROGRESS.keys())
    for uid in joins_in_progress:
        try:
            j = cfg.JOINS_IN_PROGRESS[uid]
        except KeyError:
            print("Ignoring error:")
            traceback.print_exc()
            continue

        if reaction.message.id == j['mid'] and user.id == j['creator'].id:
            reacted = False
            if reaction.emoji == '✅':
                reacted = True
                try:
                    await j['vc'].set_permissions(j['requester'], connect=True)
                    await j['requester'].move_to(j['vc'])
                except discord.errors.Forbidden:
                    await j['msg'].edit(
                        content=":warning: I don't have permission to move {} to **{}** :(".format(
                            j['requester'].mention, func.esc_md(j['vc'].name)
                        ))
                except discord.errors.HTTPException as e:
                    await j['msg'].edit(
                        content=":warning: Unable to move {} to {}'s channel ({})".format(
                            j['requester'].mention, j['creator'].mention, e.text
                        ))
                else:
                    await j['msg'].delete(delay=5)
            elif reaction.emoji in ['❌', '⛔']:
                reacted = True
                try:
                    await j['requester'].move_to(None)
                except discord.errors.Forbidden:
                    pass
                except discord.errors.HTTPException:
                    pass
                else:
                    await j['msg'].edit(
                        content="Sorry {}, your request to join {} was denied.".format(
                            j['requester'].mention, j['creator'].mention
                        ))
                if reaction.emoji == '⛔':
                    try:
                        await j['jc'].set_permissions(j['requester'], connect=False)
                    except Exception as e:
                        await j['msg'].edit(
                            content="{}\nFailed to block user ({}).".format(j['msg'].content,
                                                                            type(e).__name__))
            if reacted:
                to_delete.append(uid)
                try:
                    await j['msg'].remove_reaction('✅', guild.me)
                    await j['msg'].remove_reaction('❌', guild.me)
                    await j['msg'].remove_reaction('⛔', guild.me)
                except discord.errors.Forbidden:
                    # Shouldn't have an issue removing your own reactions, but apparently sometimes you do.
                    pass
                except discord.errors.NotFound:
                    pass
    for uid in to_delete:
        try:
            del cfg.JOINS_IN_PROGRESS[uid]
        except KeyError:
            pass  # Already deleted


@client.event
async def on_reaction_remove(reaction, user):
    if not client.is_ready():
        return

    if user.bot:
        return

    guild = reaction.message.guild
    guilds = func.get_guilds(client)
    if guild not in guilds:
        return

    if reaction.message.id in cfg.VOTEKICKS:
        if reaction.emoji == '✅':
            vk = cfg.VOTEKICKS[reaction.message.id]
            if user in vk['in_favor'] and user in vk['participants']:
                vk['in_favor'].remove(user)
                return


@client.event
async def on_voice_state_update(member, before, after):
    if not client.is_ready():
        return

    if before.channel == after.channel:
        # Ignore mute/unmute events
        return

    guild = member.guild
    guilds = func.get_guilds(client)
    if guild not in guilds:
        return

    settings = utils.get_serv_settings(guild)
    if not settings['enabled']:
        return

    if not settings['auto_channels']:
        # No channels have been set up, do nothing
        return

    secondaries = func.get_secondaries(guild, settings)
    join_channels = func.get_join_channels(guild, settings)

    if after.channel:
        if after.channel.id in settings['auto_channels']:
            await func.create_secondary(guild, after.channel, member)
        elif after.channel.id in secondaries:
            if after.channel.name != "⌛":
                await func.update_text_channel_role(guild, member, after.channel, "join")
                bitrate = await func.update_bitrate(after.channel, settings)
                await func.server_log(
                    guild,
                    "➡ {} (`{}`) joined \"**{}**\" (`{}`)".format(
                        func.user_hash(member), member.id, after.channel.name, after.channel.id
                    ) + (" ⤏ {}kbps".format(round(bitrate / 1000)) if bitrate else ""), 3, settings
                )
        elif after.channel.id in join_channels:
            sv = join_channels[after.channel.id]
            msg_channel = guild.get_channel(sv['msgs'])
            vc = guild.get_channel(sv['vc'])
            creator = guild.get_member(sv['creator'])
            if msg_channel and creator and vc:
                try:
                    m = await msg_channel.send(
                        "Hey {},\n{} would like to join your private voice channel. React with:\n"
                        "• ✅ to **allow**.\n"
                        "• ❌ to **deny** this time.\n"
                        "• ⛔ to deny and **block** future requests from them.".format(
                            creator.mention, member.mention
                        )
                    )
                    cfg.JOINS_IN_PROGRESS[member.id] = {
                        "creator": creator,
                        "requester": member,
                        "vc": vc,
                        "jc": after.channel,
                        "msg": m,
                        "mid": m.id
                    }
                    log("{} ({}) requests to join {}".format(
                        member.display_name, member.id, creator.display_name), guild)
                    try:
                        await m.add_reaction('✅')
                        await m.add_reaction('❌')
                        await m.add_reaction('⛔')
                    except discord.errors.Forbidden:
                        pass
                except Exception as e:
                    log("Failed to send join-request message ({})".format(type(e).__name__), guild)
                else:
                    cfg.JOINS_IN_PROGRESS[member.id]

    if before.channel:
        if before.channel.id in secondaries:
            members = [m for m in before.channel.members if not m.bot]
            bitrate = None
            if members:
                await func.update_text_channel_role(guild, member, before.channel, "leave")
                bitrate = await func.update_bitrate(before.channel, settings, user_left=member)
            await func.server_log(
                guild,
                "🚪 {} (`{}`) left \"**{}**\" (`{}`)".format(
                    func.user_hash(member), member.id, before.channel.name, before.channel.id
                ) + (" [bitrate: {}kbps]".format(round(bitrate / 1000)) if bitrate else ""), 3,
                settings
            )
            if not members:
                await func.delete_secondary(guild, before.channel)


@client.event
async def on_guild_join(guild):
    num_members = len([m for m in guild.members if not m.bot])
    important = num_members > 50000
    if cfg.SAPPHIRE_ID is None:
        settings = utils.get_serv_settings(guild)
        settings['left'] = False
        utils.set_serv_settings(guild, settings)
        log("Joined guild {} `{}` with {} members".format(guild.name, guild.id, num_members))
    await func.admin_log(
        ":bell:{} Joined: **{}** (`{}`) - **{}** members".format(
            utils.guild_size_icon(num_members),
            func.esc_md(guild.name),
            guild.id,
            num_members),
        client,
        important=important)


@client.event
async def on_guild_remove(guild):
    num_members = len([m for m in guild.members if not m.bot])
    if cfg.SAPPHIRE_ID is None:
        settings = utils.get_serv_settings(guild)
        settings['left'] = datetime.now(pytz.timezone(cfg.CONFIG['log_timezone'])).strftime(
            "%Y-%m-%d %H:%M")
        utils.set_serv_settings(guild, settings)
        log("Left guild {} `{}` with {} members".format(guild.name, guild.id, num_members))
    if 'leave_inactive' in cfg.CONFIG and guild.id in cfg.CONFIG['leave_inactive']:
        pass
    elif 'leave_unauthorized' in cfg.CONFIG and guild.id in cfg.CONFIG['leave_unauthorized']:
        pass
    else:
        await func.admin_log(
            ":new_moon: Left: **{}** (`{}`) - **{}** members".format(
                func.esc_md(guild.name),
                guild.id,
                num_members),
            client)


async def loop_error_override(Exception):
    '''Called if unhandled exception occurs in any of our defined loops'''

    error_text = traceback.format_exc()
    print(error_text)

    error_text = "<@{}> loop error\n```py\n{}".format(cfg.CONFIG['admin_id'], error_text)
    error_text += "\n```"
    try:
        await func.admin_log(error_text, client)
    except:
        pass  # Such programming wow


cleanup(client=client, tick_=1)
for ln, l in loops.items():
    l.add_exception_type(RuntimeError)
    l.error(loop_error_override)
    l.start(client)
check_patreon.start()
client.run(TOKEN)
