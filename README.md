# Auto-Voice-Channels
A Discord bot that automatically creates voice channels as they are needed.

Public bot invite link: <https://discordapp.com/api/oauth2/authorize?client_id=479393422705426432&permissions=286280784&scope=bot>

Requires:

* Python 3.5.3+
* pytz
* psutil

## Quick start:

* Clone: `git clone git@github.com:gregzaal/Auto-Voice-Channels.git`
* `cd Auto-Voice-Channels`
* Install pip: `sudo apt-get -y install python3-pip`
* Install venv: `pip3 install virtualenv`
* Make venv: `python3 -m virtualenv bot-env`
* Use venv: `. bot-env/bin/activate`
* Install dependencies:

```
python3 -m pip install -U discord.py
pip install pytz
pip install psutil
```

* Create your application + bot here: <https://discordapp.com/developers/applications>
* Set up `config.json`:
  * `admin_id` is your ID, for the bot to DM you when it logs on, joins servers, gets errors, etc.
  * `client_id` is the bot ID.
  * `log_timezone` is for the time displayed in logs, see [this list](https://stackoverflow.com/questions/13866926/is-there-a-list-of-pytz-timezones).
  * `loop_interval` is the default interval of the main loop that renames channels. This gets increased/decreased dynamically depending on the number of active channels.
  * `token` is your bot's private token you can find [here](https://discordapp.com/developers/applications) - do not share it with anyone else.

```json
{
    "admin_id":123456789012345678,
    "client_id":987654321098765432,
    "log_timezone":"Africa/Johannesburg",
    "loop_interval":7,
    "token":"XXXXXXXXXXXXXXXXXXXXXXXX.XXXXXX.XXXXXXXXXXXXXXXXXXXXXXXXXXX"
}
```

* Invite the bot to your own server: https://discordapp.com/api/oauth2/authorize?client_id=`<BOT ID>`&permissions=286280784&scope=bot - replace `<BOT ID>` with the client ID above.
* Start your bot: `python3 auto-voice-channels.py`

## Help:

[Join the support server](https://discord.gg/HT6GNhJ).
