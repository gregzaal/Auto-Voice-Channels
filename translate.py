import unicodedata
from utils import match_case

mc = match_case

digits = {
    '0': "Zero",
    '1': "One",
    '2': "Two",
    '3': "Three",
    '4': "Four",
    '5': "Five",
    '6': "Six",
    '7': "Seven",
    '8': "Eight",
    '9': "Nine",
}


def uwu(s):
    ''' Sources:
    https://github.com/QuazzyWazzy/UwU-fy
    https://github.com/mackyclemen/uwu-cpp
    https://github.com/mackyclemen/uwu-android
    '''

    # Rs & Ls to Ws
    tmp = ""
    for i, c in enumerate(s):
        if c.lower() in ['r', 'l']:
            c = mc('w', c)
        tmp += c
    s = tmp

    # Japanize?
    trans = [
        [["wove"], "wuv"],
        [["wewcome"], "youkoso"],
        [["is that so"], "naruhodo"],
        [["that's why", "thats why"], "dakara"],
        [["what"], "nani"],
        [["when"], "itsu"],
        [["the"], "za"],
        [["wowwd"], "warudo"],
        [["good morning"], "ohayou"],
        [["good aftewnoon"], "konnichiwa"],
        [["good night"], "oyasumi"],
        [["thank you", "thanks", "tnx", "ty"], "arigatou"],
        [["bye bye", "bye", "goodbye"], "sayonara"],
        [["sowwy", "apowogies"], "gomenasai"],
        [["my bad"], "warukatta"],
        [["excuse me"], "sumimasen"],
        [["wife"], "waifu"],
        [["husband"], "hasubando"],
        [["cute"], "kawaii"],
        [["nice"], "suteki"],
        [["bad"], "warui"],
        [["coow"], "sugoi"],
        [["handsome"], "kakkoi"],
        [["idiot"], "baka"],
        [["dumb", "dumbass"], "aho"],
        [["undewstand"], "wakarimasu"],
        [["undewstood"], "wakatta"],
        [["dead"], "deddo"],
        [["shut up", "shut the fuck up", "stfu", "shutup", "shattap"], "urusai"],
        [["fuck"], "fack"],
        [["fucked"], "facked"],
        [["fucking"], "facking"],
        [["this is bad", "oh no", "that's bad", "thats bad"], "yabai"],
        [["name"], "namae"],
        [["sistew"], "oneesan"],
        [["bwothew"], "oniichan"],
        [["wittwe sistew"], "imouto"],
        [["wittwe bwothew"], "otouto"],
        [["fwiends"], "fwends"],
        [["fwiend"], "fwend"],
        [["awwy", "awwies", "comnrade", "comrades"], "nakama"],
        [["enemy", "enemies", "nemesis"], "teki"],
        [["see you", "see ya"], "mata ne"],
        [["good wuck", "goodwuck", "do your best", "you got this"], "ganbatte"],
        [["dog"], "inu"],
        [["cat"], "neko"],
        [["with"], "wid"],
        [["without"], "widout"],
    ]
    trans_d = {}
    for t in trans:
        for w in t[0]:
            trans_d[w] = t[1]
    s = ' '.join([mc(trans_d[w.lower()], w) if w.lower() in trans_d else w for w in s.split(' ')])

    replacements = {
        "no": "nyo",
        "mo": "myo",
        "No": "Nyo",
        "Mo": "Myo",
        "NO": "NYO",
        "MO": "MYO",
        "hu": "hoo",
        "Hu": "Hoo",
        "HU": "HOO",
        "th": "d",
        "Th": "D",
        "TH": "D",
    }
    for r, rv in replacements.items():
        s = s.replace(r, rv)

    return s


def small_caps(s):
    new_s = ""
    for c in s:
        if c.islower():
            try:
                new_s += unicodedata.lookup("LATIN LETTER SMALL CAPITAL " + c)
            except KeyError:
                new_s += c
        else:
            new_s += c
    return new_s


def mathematical_unicode(mode, s):
    new_s = ""
    for c in s:
        nc = c
        case = "Capital"
        if c.islower():
            case = "Small"
        try:
            int(c)
        except ValueError:
            pass
        else:
            case = "Digit"
            nc = digits[c]
        try:
            new_s += unicodedata.lookup("Mathematical {} {} {}".format(mode, case, nc))
        except KeyError:
            new_s += c
    return new_s


def bold(s):
    return mathematical_unicode("Bold", s)


def italic(s):
    return mathematical_unicode("Italic", s)


def bolditalic(s):
    return mathematical_unicode("Bold Italic", s)


def script(s):
    return mathematical_unicode("Script", s)


def boldscript(s):
    return mathematical_unicode("Bold Script", s)


def fraktur(s):
    return mathematical_unicode("Fraktur", s)


def boldfraktur(s):
    return mathematical_unicode("Bold Fraktur", s)


def double(s):
    return mathematical_unicode("Double-Struck", s)


def sans(s):
    return mathematical_unicode("Sans-Serif", s)


def boldsans(s):
    return mathematical_unicode("Sans-Serif Bold", s)


def italicsans(s):
    return mathematical_unicode("Sans-Serif Italic", s)


def bolditalicsans(s):
    return mathematical_unicode("Sans-Serif Bold Italic", s)


def mono(s):
    return mathematical_unicode("Monospace", s)
