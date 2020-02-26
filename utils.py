import asyncio
import discord
import functools
import json
import operator
import os
import traceback
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime
from itertools import islice
from random import choice, seed
from requests import get
from time import time
from inspect import currentframe as iframe

import cfg
import pytz


def func_timer(threshold=0.5):
    def duration(func):

        @contextmanager
        def wrapping_logic(parent_func):
            start_ts = time()
            yield
            duration = time() - start_ts
            if duration >= threshold:
                print("TIMER: {0:.3f}s '{1}' called by '{2}'".format(duration, func.__name__, parent_func))

        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            parent_func = iframe().f_back.f_code.co_name
            if not asyncio.iscoroutinefunction(func):
                with wrapping_logic(parent_func):
                    return func(*args, **kwargs)
            else:
                async def tmp():
                    with wrapping_logic(parent_func):
                        return (await func(*args, **kwargs))
                return tmp()
        return wrapper
    return duration


@func_timer()
def format_timings():
    s = ""
    l = [[k, cfg.TIMINGS[k]] for k in cfg.TIMINGS]
    l.sort(key=lambda k: k[1], reverse=True)
    for t in l:
        s += "`{0}`: {1:.2f}\n".format(t[0], t[1])
    return s.strip()


@func_timer()
def log(msg, guild=None):
    text = datetime.now(pytz.timezone(cfg.CONFIG['log_timezone'])).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    if guild:
        text += " [{}]{}".format(
            guild.name,
            "<{}>".format(guild.shard_id) if guild.shard_id != 0 else ""
        )
    text += "\n    "
    text += str(msg)
    print(text)


@func_timer()
def read_json(fp):
    with open(fp, 'r') as f:
        data = json.load(f)
    return data


@func_timer()
def write_json(fp, data, indent=1):
    cfg.WRITES_IN_PROGRESS.append(fp)
    d = os.path.dirname(fp)
    if not os.path.exists(d):
        os.makedirs(d)
    try:
        s = json.dumps(data, indent=indent, separators=(",", ":"), sort_keys=True)
    except:
        traceback.print_exc()
    else:
        with open(fp, 'w') as f:
            f.write(s)
    cfg.WRITES_IN_PROGRESS.remove(fp)


@func_timer()
def get_config():
    cf = os.path.join(cfg.SCRIPT_DIR, 'config.json')
    if not os.path.exists(cf):
        print("Config file doesn't exist!")
        import sys
        sys.exit(0)
    return read_json(cf)


@func_timer()
def update_server_location():
    try:
        print("Getting server location...")
        j = json.loads(get("http://ip-api.com/json/").text)
        cfg.SERVER_LOCATION = "{}, {}, {}".format(j['city'], j['region'], j['country'])
        print(cfg.SERVER_LOCATION)
    except:
        print("Failed to update server location")
        print(traceback.format_exc())


@func_timer()
def get_serv_settings(guild):
    if guild.id in cfg.GUILD_SETTINGS:
        cfg.PREV_GUILD_SETTINGS[guild.id] = deepcopy(cfg.GUILD_SETTINGS[guild.id])
        return cfg.GUILD_SETTINGS[guild.id]

    fp = os.path.join(cfg.SCRIPT_DIR, 'guilds', str(guild.id) + '.json')
    if not os.path.exists(fp):
        write_json(fp, read_json(os.path.join(cfg.SCRIPT_DIR, 'default_settings.json')))
    data = read_json(fp)

    # Convert string IDs to ints
    old_data = deepcopy(data)
    for p, v in old_data['auto_channels'].items():
        del data['auto_channels'][p]
        if isinstance(v['secondaries'], list):
            # Convert old secondaries[] to secondaries{}
            v['secondaries'] = dict.fromkeys(v['secondaries'], {"creator": 1})
        old_v = deepcopy(v)
        for s, sv in old_v['secondaries'].items():
            del v['secondaries'][s]
            v['secondaries'][int(s)] = sv
        data['auto_channels'][int(p)] = v
    if 'creators' in data:  # Old method of storing creators
        del data['creators']

    cfg.GUILD_SETTINGS[guild.id] = data
    cfg.PREV_GUILD_SETTINGS[guild.id] = data
    return cfg.GUILD_SETTINGS[guild.id]


@func_timer()
def set_serv_settings(guild, settings):
    # prev_settings = cfg.PREV_GUILD_SETTINGS[guild.id]
    # prev_num_channels = 0
    # for p in prev_settings['auto_channels']:
    #     prev_num_channels += len(prev_settings['auto_channels'][p]['secondaries'])

    # num_channels = 0
    # for p in settings['auto_channels']:
    #     num_channels += len(settings['auto_channels'][p]['secondaries'])

    # if num_channels < prev_num_channels:
    #     print("{}REM:{} {} ln:{} fn:{} gt:{} gnt:{}".format(
    #         ' ' * 16,
    #         prev_num_channels - num_channels,
    #         guild.id,
    #         iframe().f_back.f_lineno,
    #         iframe().f_back.f_code.co_name,
    #         type(guild).__name__,
    #         type(guild.name).__name__)
    #     )

    settings['guild_name'] = guild.name
    cfg.GUILD_SETTINGS[guild.id] = settings
    fp = os.path.join(cfg.SCRIPT_DIR, 'guilds', str(guild.id) + '.json')
    return write_json(fp, settings)


@func_timer()
def permastore_secondary(cid):
    success = False
    attempts = 0
    while not success and attempts < 100:
        attempts += 1
        try:
            with open(os.path.join(cfg.SCRIPT_DIR, "secondaries.txt"), 'a') as f:
                f.write(str(cid) + '\n')
        except:
            print("Failed to remember {}".format(cid))
        else:
            success = True


@func_timer()
def clean_permastore():
    fp = os.path.join(cfg.SCRIPT_DIR, "secondaries.txt")
    if not os.path.exists(fp):
        return

    with open(fp, 'r') as f:
        lines = f.readlines()

    lines = lines[-10000:]  # Drop all but the last 10k lines

    with open(fp, 'w') as f:
        f.writelines(lines)


@func_timer()
def count_lines(fp):
    n = 0
    with open(fp, 'r', encoding="utf8") as f:
        n += len([l for l in f.readlines() if l.strip()])
    return n


@func_timer()
def get_primary_channel(guild, settings, channel):
    for p, v in settings['auto_channels'].items():
        for s in v['secondaries']:
            if s == channel.id:
                return guild.get_channel(p)


@func_timer()
def get_creator_id(settings, channel):
    for p, pv in settings['auto_channels'].items():
        for s, sv in pv['secondaries'].items():
            if s == channel.id:
                return sv['creator']


@func_timer()
def plain_mention(mention):
    # Remove '!' from mention so that user and member mentions are the same.
    return mention.replace('!', '')


@func_timer()
def get_user_in_channel(name, channel):
    members = channel.members
    name = name.strip()
    for m in members:
        if plain_mention(m.mention) == plain_mention(name):
            return m
    for m in members:
        if m.name.lower() + '#' + m.discriminator == name.lower():
            return m
    for m in members:
        if m.display_name.lower() == name.lower():
            return m
    return False


@func_timer()
def num_active_channels(guilds):
    num_channels = 0
    for g in guilds:
        settings = get_serv_settings(g)
        for p in settings['auto_channels']:
            num_channels += len(settings['auto_channels'][p]['secondaries'])
    return num_channels


@func_timer()
def num_active_guilds(guilds):
    curtime = time()
    num_guilds = 0
    for g in guilds:
        settings = get_serv_settings(g)
        if 'last_activity' in settings:
            age = curtime - settings['last_activity']
            if age / 604800 <= 3:  # 3 Weeks
                num_guilds += 1
    return num_guilds


@func_timer()
def num_shards(guilds):
    shards = []
    for g in guilds:
        if g.shard_id not in shards:
            shards.append(g.shard_id)
    return len(shards)


@func_timer()
def guild_size_icon(n):
    if n < 500:
        return ""
    elif n < 1500:
        return "💜"
    elif n < 10000:
        return "✨"
    elif n < 100000:
        return "🔥💗"
    else:
        return "💥🔥💗✨"


@func_timer()
def ldir(o):
    ''' Get all attributes/functions of an object, return them as a string in a nice format '''
    return '[\n' + (',\n'.join(dir(o))) + '\n]'


@func_timer()
def fmsg(m):
    # Format message to display in a code block
    s = '```\n'
    s += str(m)
    s += '\n```'
    return s


@func_timer()
def strip_quotes(s):
    # TODO just use s.strip("\"' ")
    chars_to_strip = ['\'', '"', ' ']
    if s:
        while s[0] in chars_to_strip:
            if len(s) <= 1:
                break
            s = s[1:]
        while s[-1] in chars_to_strip:
            if len(s) <= 1:
                break
            s = s[:-1]
    return s


@func_timer()
def match_case(target, source):
    if source.isupper():
        return target.upper()
    if source.islower():
        return target.lower()
    if source.istitle():
        return target.title()
    if len(source) > 1:
        if source[0].isupper() and source[1].isupper():
            return target.upper()
        if source[0].islower() and source[1].islower():
            return target.lower()
        if source[0].isupper() and source[1].islower():
            return target.title()
    return target


@func_timer()
def capitalize(s):
    # s.title() does bad stuff with apostrophes, need to use our own method.
    return ' '.join(x.capitalize() for x in s.split())


@func_timer()
def random_case(s):
    seed_s = datetime.now().strftime("%Y%m%d%H") + s
    seed_i = 0
    for c in seed_s:
        seed_i += ord(c)

    ops = [str.upper, str.lower]
    new_s = ""
    for i, c in enumerate(s):
        seed(seed_i + i)
        new_s += choice(ops)(c)
    return new_s


@func_timer()
def first_n_words(s, n=1):
    return ' '.join(s.split(' ')[:n])


@func_timer()
def acronym(s):
    words = s.split(' ')
    return ''.join(w[0] for w in words if w)


@func_timer()
def remove_short_words(s):
    words = s.split(' ')
    short_words = "a an and at by from in is of on or the to".split(' ')
    new_words = [w for w in words if w.lower() not in short_words]
    return ' '.join(new_words)


@func_timer()
def full_strip(s):
    s = s.strip()
    while '  ' in s:
        s = s.replace('  ', ' ')
    return s


@func_timer()
def upsidedown(s):
    try:
        import upsidedown as _upsidedown
        return ''.join((_upsidedown.transform(s)))
    except ImportError:
        log("Cannot import upsidedown")
        return s


@func_timer()
def ascii_only(s):
    ns = ""
    printable_chars = list([chr(i) for i in range(32, 127)])
    for c in s:
        if c in printable_chars:
            ns += c
        else:
            ns += '_'
    return ns


@func_timer()
def nice_cname(text):
    text = text.replace('/', ' ⁄ ')
    text = text.replace(' ', ' ')  # Fake space character
    return text


@func_timer()
def get_display_name(settings, user):
    uid = str(user.id)
    if 'custom_nicks' in settings:
        if uid in settings['custom_nicks']:
            return settings['custom_nicks'][uid]
    return user.display_name


@func_timer()
def eval_expression(text, is_sapphire, creator, party, game_name):
    act = creator.activity
    variables = {
        'ROLE': [r.id for r in creator.roles],
        'LIVE': ((creator.voice and hasattr(creator.voice, 'self_stream') and creator.voice.self_stream) or
                 (act and act.type == discord.ActivityType.streaming)),
        'GAME': game_name,
    }
    if is_sapphire:
        try:
            variables['PLAYERS'] = int(party['num_playing']) if party else 0
        except ValueError:
            variables['PLAYERS'] = 0
        try:
            variables['MAX'] = int(party['size']) if party else 0
        except (ValueError, IndexError):
            variables['MAX'] = 0

        variables['RICH'] = party['rich'] if party else False

    ops = [  # 2D list - can't use dict as it needs to be ordered
        ["<=", operator.le],
        [">=", operator.ge],
        ["<", operator.lt],
        [">", operator.gt],
        ["!=", operator.ne],
        ["=", operator.eq],
        [":", operator.contains],
    ]

    if '??' not in text:
        return text

    c, t = text.split('??', 1)

    if '//' in t:
        t, f = t.split('//', 1)
    else:
        f = ""

    ch = c.strip()
    cv = None
    op = None
    fn = None
    for o in ops:
        if o[0] in c:
            op = o[0]
            fn = o[1]
            ch, cv = c.split(op, 1)
            ch = ch.strip()
            cv = cv.strip()
            break

    if ch in variables:
        ch = variables[ch]
        if op:
            try:
                cv = int(cv)
            except ValueError:
                pass

            try:
                c = fn(ch, cv)
            except TypeError:
                pass
        else:
            c = bool(ch)

    return t if c and isinstance(c, bool) else f


@func_timer()
def debug_unicode(s):
    text = ""
    for c in s:
        if 32 <= ord(c) <= 126:
            text += c
        else:
            text += '`'
            text += str(ord(c))
            text += '` '
    if text == s:
        # All simple ascii characters, no need to print anything
        return ""
    else:
        return '(' + text + ')'


@func_timer()
def chunks(l, n):
    """Yield successive n-sized chunks from l."""
    for i in range(0, len(l), n):
        yield l[i:i + n]


@func_timer()
def dict_chunks(data, size=25):
    it = iter(data)
    for i in range(0, len(data), size):
        yield {k: data[k] for k in islice(it, size)}


@func_timer()
async def hastebin(s):
    from aiohttp import ClientSession
    url = "https://hastebin.com"
    async with ClientSession() as session:
        async with session.post(url + "/documents", data=s.encode('utf-8')) as post:
            return url + '/' + (await post.json())['key']
