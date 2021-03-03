# Auto-Voice-Channels

### A Discord bot that automatically creates voice channels as they are needed.

- [Public bot invite link](https://discordapp.com/api/oauth2/authorize?client_id=479393422705426432&permissions=286280784&scope=bot)
- [Beta bot invite link](https://discordapp.com/api/oauth2/authorize?client_id=675405085752164372&permissions=286280784&scope=bot)
- [Discord server](https://discord.gg/HT6GNhJ)
- [Patreon](https://www.patreon.com/pixaal)



## Manual Quick Start:
### Requires:

* [Python 3.5.3+](https://www.python.org/downloads/)
* [discord.py](https://pypi.org/project/discord.py/) (`pip install discord.py`)
* [pytz](https://pypi.org/project/pytz/) (`pip install pytz`)
* [psutil](https://pypi.org/project/psutil/) (`pip install psutil`)
* [Requests](https://pypi.org/project/requests/) (`pip install requests`)

## Optional Extras:

* [uvloop](https://pypi.org/project/uvloop/) (`pip install uvloop`) - **UNIX ONLY**

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
* Enable both **Presence** and **Server Members** Privileged Gateway Intents in the Bot section.
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

## Using docker
### Requires:

* Docker for [windows](https://docs.docker.com/docker-for-windows/install/) or [linux](https://docs.docker.com/engine/install/)
* [Docker Compose](https://docs.docker.com/compose/install/)

* Clone the repository: `git clone https://github.com/gregzaal/Auto-Voice-Channels.git`
* Create your application + bot here: <https://discordapp.com/developers/applications>
* Invite the bot to your own server, replacing `<YOUR BOT ID>` with... your bot ID: `https://discordapp.com/api/oauth2/authorize?client_id=<YOUR BOT ID>&permissions=286280784&scope=bot`
* build/run, make sure all commands are ran within your 
  * Use docker run command
  First create your image
  ```shell
  docker build -t auto-voice-channels .
  ```
  Then run it, make sure you change ENVs and your volume path
  ```shell
  docker run \
  --name=auto-voice-channels \
  -e admin_id=<your admin id> \
  -e client_id=<your client id> \
  -e log_timezone=Africa/Johannesburg \
  -e token=<your token> \
  -v path to data:/AutoVoiceChannels/guilds \
  --restart unless-stopped \
  auto-voice-channels
  ```
  * Use docker-compose, make sure you change ENVs and your volume path
  ```yaml
  version: "2.2"

  services:
    autovoice:
      build: .
      image: autovoicechannels:latest
      environment:
        - admin_id=<your admin id>
        - client_id=<your client id>
        - log_timezone=Africa/Johannesburg
        - token=<your token>
      volumes:
        - path to data:/AutoVoiceChannels/guilds
  ```

### Parameters
| Parameter        | Function |
| -----------      | ----------- |
| `-e admin_id`    | is your ID, for the bot to DM you when it logs on, joins servers, gets errors, etc|
| `-e client_id`   | is the bot ID|
| `-e log_timezone`| is for the time displayed in logs, see [this list](https://stackoverflow.com/questions/13866926/is-there-a-list-of-pytz-timezones)|
| `-e token`       | is your bot's private token you can find [here](https://discordapp.com/developers/applications) - do not share it with anyone else|

## Help:

For **all** issues and questions you have, first ask in our [Support Server](https://discord.gg/HT6GNhJ). 99% of questions have been asked before and already have a solution available. Read the FAQ, #status channel, and pinned messages.

If you're self-hosting and have an actual code bug to report, also first check in the Support Server for a solution and see if anyone else has the same problem. If someone can confirm your bug in their own self-hosted bot, then you may [open an issue](https://github.com/gregzaal/Auto-Voice-Channels/issues).
