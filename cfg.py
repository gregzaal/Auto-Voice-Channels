import os
from utils import get_config
from time import time

SCRIPT_DIR = os.path.dirname(os.path.realpath(__file__))
SCRIPT_DIR = SCRIPT_DIR + ('/' if not SCRIPT_DIR.endswith('/') else '')
SAPPHIRE_ID = None
INVITE_LINK = "https://discordapp.com/api/oauth2/authorize?client_id=@@CID@@&permissions=286280784&scope=bot"

TIER_ICONS = {
    'gold': ':credit_card:',
    'sapphire': ':gem:',
    'diamond': ':diamond_shape_with_a_dot_inside:',
}

# Store settings so we don't have to read them from drive all the time
GUILD_SETTINGS = {}
PREV_GUILD_SETTINGS = {}

# Store Patreon stuff so we can use it globally and don't have to read it all on every is_gold check
PATREON_DATA = {}
PATRONS = {}
NUM_PATRONS = -1
GOLD_SERVERS = []
SAPPHIRE_SERVERS = []

# Track writes in progress so we don't exit during a write operation
WRITES_IN_PROGRESS = []

# Dict to keep track of channel ids that are busy to them to prevent duplicate requests and potential errors.
# {"channel_id": "epoch time requested"}
CURRENT_REQUESTS = {}

# Same as above but to prevent user spam join abuse
# {"user_id": "epoch time requested"}
USER_REQUESTS = {}
USER_ABUSE_EVENTS = {}
ABUSE_THRESHOLD = 4

VOTEKICKS = {}
PRIV_CHANNELS = {}
JOINS_IN_PROGRESS = {}

# In case we need to store actual channel names when template/game/user name contains illegal characters.
ATTEMPTED_CHANNEL_NAMES = {}

# Dict of message IDs with timestamp to avoid spamming error messages several times in a row
ERROR_MESSAGES = {}
DM_ERROR_MESSAGES = {}
DISCONNECTED = False

# Cached prefixes so we don't have to read settings file on every message
PREFIXES = {}

FIRST_RUN_COMPLETE = False
SERVER_LOCATION = 'Unknown'

TICK_TIME = 0
G_TICK_TIME = 0
TIMING_LOG = 0
TIMINGS = {}

SEED = int(time())

CONFIG = get_config()

defaults = {
    'loop_interval': 7,
    'gold_interval': 3,
    'sapphires': {}
}
for d, dv in defaults.items():
    if d not in CONFIG:
        CONFIG[d] = dv

TICK_RATE = CONFIG['loop_interval']
