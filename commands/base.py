class Cmd:

    def __init__(
        self,
        help_text,
        execute,
        params_required=0,
        voice_required=False,
        creator_only=False,
        admin_required=False,
        gold_required=False,
        sapphire_required=False,
    ):
        self.help_text = help_text
        self.execute = execute
        self.params_required = params_required
        self.voice_required = voice_required
        self.creator_only = creator_only
        self.admin_required = admin_required
        self.gold_required = gold_required
        self.sapphire_required = sapphire_required

    def print_help(self):
        return True, self.help_text
