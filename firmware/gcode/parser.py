"""Reading gcode a line at a time.

Plot files are routinely larger than the Pico's RAM, so nothing here ever holds
more than one line. The parser is a generator over an iterable of lines — a
file object, a socket, a list in a test — and yields one command per line that
has one.

The dialect is docs/GCODE.md. Only what the app emits is understood, and
anything else is reported rather than guessed at: a plotter that silently
ignores a word it does not know draws the wrong picture.
"""


class Command:
    """One parsed line: a letter, a number, and the words that came with it."""

    __slots__ = ("kind", "code", "words", "line_number", "text")

    def __init__(self, kind, code, words, line_number, text):
        self.kind = kind
        self.code = code
        self.words = words
        self.line_number = line_number
        self.text = text

    def __repr__(self):
        return "Command(%s%d, %r)" % (self.kind, self.code, self.words)


class GcodeError(Exception):
    """A line that cannot be run. Carries where, so the app can say where."""

    def __init__(self, message, line_number, text):
        Exception.__init__(self, "line %d: %s" % (line_number, message))
        self.line_number = line_number
        self.text = text


#: Words carrying a value, and whether a job may see them more than once.
_VALUE_WORDS = "XYZFIJPSR"

#: Commands this firmware runs. Anything else on a G or M line is an error.
_KNOWN = {
    ("G", 0), ("G", 1), ("G", 4), ("G", 28), ("G", 90), ("G", 91),
    ("G", 20), ("G", 21),
    ("M", 0), ("M", 2), ("M", 30),
}


def strip_comment(line):
    """Remove `;` comments and `(...)` remarks, and surrounding space."""
    semicolon = line.find(";")
    if semicolon >= 0:
        line = line[:semicolon]

    # Parenthesised remarks may appear mid-line, and may repeat.
    while True:
        start = line.find("(")
        if start < 0:
            break

        end = line.find(")", start)
        if end < 0:
            # Unclosed: the rest of the line is a remark.
            line = line[:start]
            break

        line = line[:start] + " " + line[end + 1:]

    return line.strip()


def parse_line(line, line_number=0):
    """One line to a Command, or None when the line carries no command."""
    text = strip_comment(line)
    if not text:
        return None

    words = {}
    kind = None
    code = None

    for token in text.split():
        letter = token[0].upper()
        rest = token[1:]

        if letter in ("G", "M"):
            if kind is not None:
                raise GcodeError("two commands on one line", line_number, line)

            try:
                number = float(rest)
            except ValueError:
                raise GcodeError("%s needs a number" % letter, line_number, line)

            if number != int(number):
                raise GcodeError("%s%s is not a whole number" % (letter, rest),
                                 line_number, line)

            kind = letter
            code = int(number)
            continue

        if letter not in _VALUE_WORDS:
            raise GcodeError("unknown word %r" % token, line_number, line)

        try:
            words[letter] = float(rest)
        except ValueError:
            raise GcodeError("%s needs a number" % letter, line_number, line)

    if kind is None:
        raise GcodeError("words with no command", line_number, line)

    if (kind, code) not in _KNOWN:
        raise GcodeError("unsupported command %s%d" % (kind, code), line_number, line)

    return Command(kind, code, words, line_number, line.rstrip("\n"))


def parse(lines):
    """Stream commands from an iterable of lines.

    A generator on purpose: the caller runs each command before the next line
    is read, so a job of any size costs one line of memory.
    """
    for number, line in enumerate(lines, start=1):
        command = parse_line(line, number)
        if command is not None:
            yield command
