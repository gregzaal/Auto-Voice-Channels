I'm a bot that allows your users to dynamically and infinitely create voice channels as they need them, and automatically delete them as soon as they are no longer used.

<div style="max-width:640px;margin-left:auto;margin-right:auto"><iframe src='https://gfycat.com/ifr/LateMealyHoneyeater' frameborder='0' scrolling='no' allowfullscreen width='640' height='360' style='height:100%'></iframe></div>

** **
**-- Quickstart --**

Run `vc/create` and I'll make a new primary channel for you. When users join this channel, I'll make a new channel for them and move them to it.

The new channel will by default be named according to the game they are playing together, e.g. *"#1 [Warframe]"*, and will rename itself if they start to play a different game - but you can change this to anything you like (see the command reference below).

Once everybody leaves the channel, I'll automatically delete it.

If you need any more help, you can talk to my master here: <https://discord.io/DotsBotsSupport>

If you like this bot, and want to help keep it alive, support me on Patreon :) <https://www.patreon.com/pixaal>

** **
**-- Commands --**

The prefix for all commands is `vc/`, e.g. `vc/create`. You can also mention me instead, like `@Auto Voice Channels create`.

To get more info about a particular command, type `vc/help <command>`.

`create` - Make a new primary voice channel. When users join this channel, I'll make a new one for them and move them into it.

`template` - Change the name template for secondary channels. Default is `## [@@game_name@@]`. Run `vc/help template` for a full list of usable variables.

`toggleposition` - Toggle whether new channels are placed above or below the primary one. Defaults to above.

`alias` - Change the displayed name for a certain game if, for example it's too long to fit in the channel sidebar.

`defaultlimit` - Set the default user limit for new channels from a particular primary channel.

`inheritpermissions` - Set how new channels get their permissions. By default they copy their primary channel.

`allyourbase` - Assume ownership of someone else's channel.

`disable` - Turn me off in this server. You can still use all my commands, but I won't create any new voice channels for anyone.

`enable` - Turn me on baby! (I'm enabled by default)

`prefix` - Change the prefix of the bot (default is `vc/`).

`dcnf` - Disable the "Command not found" error when you type a command that I don't recognize.

`channelinfo` - A debugging command to get information about the channel you're in.

`servercheck` - Get information about this server, such as the voice channels I know about and the Patreon status.

`listroles` - List all of the roles (and their IDs) in the server, or all the roles that a particular user has.

All the above commands are restricted to admin users. The commands below can be used by anyone.

`help` - This message :) Use `vc/help <command>` to get more information about a particular command.

`limit`/`lock` - Limit the number of users allowed in your channel to either the current number of users, or the specified number. Use `unlimit`/`unlock` to remove the limit.

`kick` - Start a votekick to remove someone from your channel.

`private` - Make your voice channel private, preventing anyone from joining you directly. Creates a "⇩ Join (username)" channel above yours so people can request to join you.

`transfer` - Make someone else the owner of your channel, treating them as the original creator who can run restricted commands.

`invite` - Get my invite link to invite me to a different server.

The following additional commands are available for **Gold Patron** servers:

`textchannels` - Toggle whether or not to create temporary private text channels for each voice chat.

`textchannelname` - Change the name of the text channels made for each voice chat if `textchannels` is on.

`showtextchannelsto ` - Show the text channels that are made for each voice channel if `textchannels` is on to users that have a specified role (e.g. moderators, or everyone).

`bitrate` *Can be used by anyone* - Set a server-wide custom bitrate (in kbps) for yourself that will be used for any channels you join.

`name` *Can be used by anyone* - Directly change the name of your voice channel. Supports all variables from the `template` command. Only the channel creator can do this.

`nick` *Can be used by anyone* - Set a nickname for yourself that will be used only in voice channel names if `@@creator@@` is in the template.

`rename` - The same as `name`, but admins can use this to rename other people's channels.

`uniquenames` - Prevent duplicate custom channel names (made with the `name` or `rename` commands).

`general` - Change the "General" that's used in the channel name when no game or multiple games are being played.

`logging` - Log voice channel activity in your server to a chosen text channel.

`restrict` - Only allow users with certain roles to use certain commands.
