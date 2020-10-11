I'm a bot that allows your users to dynamically and infinitely create voice channels as they need them, and automatically delete them as soon as they are no longer used.

More detailed info is available on the wiki: https://wiki.dotsbots.com

** **
**-- Quickstart --**

Run `vc/create` and I'll make a new primary channel for you. When users join this channel, I'll make a new channel for them and move them to it.

The new channel will by default be named according to the game they are playing together, e.g. *"#1 [Warframe]"*, and will rename itself if they start to play a different game - but you can change this to anything you like (see the command reference below).

Once everybody leaves the channel, I'll automatically delete it.

** **
**-- Commands --**

Here are the most commonly used commands. For the full list of commands available and more detail on how to use them check the wiki: https://wiki.dotsbots.com/en/commands

`vc/create` - Make a new primary voice channel. When users join this channel, I'll make a new one for them and move them into it.

`vc/template` - Change the name template for secondary channels. Default is `## [@@game_name@@]`. Run `vc/help template` for a full list of usable variables.

`vc/private` - Make your voice channel private, preventing anyone from joining you directly.

`vc/lock` or `vc/limit` - Lock or set the user limit of your channel to prevent any more people from being able to join.

`vc/ping` - A quick test command to check the bot is working, and show its response time. Frequently high response times (>2s) may indicate performance issues.
