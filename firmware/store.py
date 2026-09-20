"""Files on the SD card.

Two rules, both from the fact that a Pico has less RAM than a plot file.

**Uploads are written as they arrive.** `open_write` hands back something that
takes chunks; nothing ever holds a whole file. A 4 MB plot lands on a machine
with 512 KB of memory because no part of the path ever sees more than one chunk
of it.

**Reads are streamed too.** `open_read` is a context manager over a file object,
and the job pulls lines through it one at a time.

The directory is injected, so the desktop tests run against a real filesystem
and the Pico runs against `/sd`. Nothing here knows which it is.
"""

import os


class StoreError(Exception):
    """Something wrong with a name or a file. Carries an API error slug."""

    def __init__(self, slug, message):
        Exception.__init__(self, message)
        self.slug = slug
        self.message = message


#: Characters a job file's name may contain. Deliberately narrow: a plotter has
#: no business accepting anything a filesystem might find interesting.
_SAFE = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_. ")


def safe_name(name):
    """Check a client-supplied filename, or refuse it.

    Path separators and `..` are refused outright rather than sanitised.
    Quietly rewriting a name the client chose means the file they upload and
    the file they ask to plot can differ, which is worse than saying no.
    """
    if not name or len(name) > 64:
        raise StoreError("bad_name", "a file name must be 1 to 64 characters")

    if name != name.strip() or name.startswith("."):
        raise StoreError("bad_name", "a file name may not start with a dot or a space")

    for character in name:
        if character not in _SAFE:
            raise StoreError("bad_name", "%r is not allowed in a file name" % character)

    return name


class Writer:
    """An upload in progress. Chunks in, bytes on the card."""

    def __init__(self, handle, path, on_close=None):
        self._handle = handle
        self.path = path
        self.bytes = 0
        self._on_close = on_close

    def write(self, chunk):
        if not chunk:
            return 0

        self._handle.write(chunk)
        self.bytes += len(chunk)
        return len(chunk)

    def close(self):
        self._handle.close()
        if self._on_close is not None:
            self._on_close(self)

        return self.bytes

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
        return False


class Store:
    """The gcode directory on the card."""

    def __init__(self, directory, usage=None):
        self.directory = directory
        #: Injected so the desktop can report a real figure and the Pico can
        #: use `os.statvfs`, without either one knowing about the other.
        self._usage = usage

    def path_for(self, name):
        return "%s/%s" % (self.directory, safe_name(name))

    def exists(self, name):
        try:
            os.stat(self.path_for(name))
            return True
        except OSError:
            return False

    def list(self):
        """Every job file on the card, newest name order left to the caller."""
        files = []

        for name in sorted(os.listdir(self.directory)):
            try:
                info = os.stat("%s/%s" % (self.directory, name))
            except OSError:
                continue

            files.append({"name": name, "bytes": info[6], "modified": int(info[8])})

        return files

    def open_write(self, name):
        """Start an upload. The caller feeds it chunks and closes it."""
        path = self.path_for(name)
        return Writer(open(path, "wb"), path)

    def open_read(self, name):
        if not self.exists(name):
            raise StoreError("not_found", "%s is not on the card" % name)

        return open(self.path_for(name), "r")

    def delete(self, name):
        if not self.exists(name):
            raise StoreError("not_found", "%s is not on the card" % name)

        os.remove(self.path_for(name))

    def usage(self):
        """Bytes used and total, for the app's storage readout."""
        if self._usage is not None:
            return self._usage()

        # MicroPython's os.statvfs: block size, fragment size, total blocks,
        # free blocks, available blocks, ...
        stats = os.statvfs(self.directory)
        block = stats[1]
        total = stats[2] * block
        free = stats[3] * block

        return {"usedBytes": total - free, "totalBytes": total}
