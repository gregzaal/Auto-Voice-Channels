# Auto-Voice-Channels

### A Discord bot that automatically creates voice channels as they are needed.

- [Public bot invite link](https://discordapp.com/api/oauth2/authorize?client_id=479393422705426432&permissions=286280784&scope=bot)
- [Beta bot invite link](https://discordapp.com/api/oauth2/authorize?client_id=675405085752164372&permissions=286280784&scope=bot)
- [Discord server](https://discord.gg/HT6GNhJ)
- [Patreon](https://www.patreon.com/pixaal)

## Requires:

* [Python 3.5.3+](https://www.python.org/downloads/)
* [discord.py](https://pypi.org/project/discord.py/) (`pip install discord.py`)
* [pytz](https://pypi.org/project/pytz/) (`pip install pytz`)
* [psutil](https://pypi.org/project/psutil/) (`pip install psutil`)
* [Requests](https://pypi.org/project/requests/) (`pip install requests`)

## Quick start:

* Clone the repository: `git clone https://github.com/gregzaal/Auto-Voice-Channels.git`
* Go to the directory: `cd Auto-Voice-Channels`
* Make folder to store guild settings: `mkdir guilds`
* Install pip: `sudo apt-get -y install python3-pip`
* Install requirements: `python3 -m pip install -r requirements.txt`
* Install venv: `pip3 install virtualenv`
* Make venv: `python3 -m virtualenv bot-env`
* Use venv: `. bot-env/bin/activate`
* Create your application + bot here: <https://discordapp.com/developers/applications>
* Set up `config.json`:
  * `admin_id` is your ID, for the bot to DM you when it logs on, joins servers, gets errors, etc.
  * `client_id` is the bot ID.
  * `log_timezone` is for the time displayed in logs, see [this list](https://stackoverflow.com/questions/13866926/is-there-a-list-of-pytz-timezones).
  * `token` is your bot's private token you can find [here](https://discordapp.com/developers/applications) - do not share it with anyone else.

```json
{
    "admin_id":123456789012345678,
    "client_id":987654321098765432,
    "log_timezone":"Africa/Johannesburg",
    "token":"XXXXXXXXXXXXXXXXXXXXXXXX.XXXXXX.XXXXXXXXXXXXXXXXXXXXXXXXXXX"
}
```

* Invite the bot to your own server, replacing `<YOUR BOT ID>` with... your bot ID: `https://discordapp.com/api/oauth2/authorize?client_id=<YOUR BOT ID>&permissions=286280784&scope=bot`
* Start your bot: `python3 auto-voice-channels.py`

## Help:

[Join the support server](https://discord.gg/HT6GNhJ) and ask, or [open an issue](https://github.com/gregzaal/Auto-Voice-Channels/issues).
