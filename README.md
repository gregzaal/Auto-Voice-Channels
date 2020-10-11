# Auto-Voice-Channels - Ubuntu 20.04

* apt-get update
* apt-get upgrade -y
* sudo apt-get install gcc -y
* sudo apt-get install git -y
* sudo apt-get install python3-pip -y
* sudo apt-get install python3-dev -y

## Requires:

* [Python 3.5.3+](https://www.python.org/downloads/)
* [discord.py](https://pypi.org/project/discord.py/) (`pip3 install discord.py`)
* [pytz](https://pypi.org/project/pytz/) (`pip3 install pytz`)
* [psutil](https://pypi.org/project/psutil/) (`pip3 install psutil`)
* [Requests](https://pypi.org/project/requests/) (`pip3 install requests`)

## Quick start:

* Clone the repository: `git clone https://github.com/gregzaal/Auto-Voice-Channels.git`
* Go to the directory: `cd Auto-Voice-Channels`
* Make folder to store guild settings: `mkdir guilds`
* Install pip: `sudo apt-get -y install python3-pip`
* Install venv: `pip3 install virtualenv`
* Make venv: `python3 -m virtualenv bot-env`
* Use venv: `. bot-env/bin/activate`
* Install requirements: `python3 -m pip install -r requirements.txt`
* Create your application + bot here: <https://discordapp.com/developers/applications>
* Create a `config.json` file in the Auto-Voice-Channels folder and fill it in:
  * `admin_id` is your ID, for the bot to DM you when it logs on, joins servers, gets errors, etc.
  * `client_id` is the bot ID.
  * `log_timezone` is for the time displayed in logs, see [this list](https://stackoverflow.com/questions/13866926/is-there-a-list-of-pytz-timezones).
  * `token` is your bot's private token you can find [here](https://discordapp.com/developers/applications) - do not share it with anyone else.
  * There are a number of [optional settings](https://github.com/gregzaal/Auto-Voice-Channels/wiki/Optional-configuration) too, which aren't necessary to set but provide some further configuration options if needed.

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
