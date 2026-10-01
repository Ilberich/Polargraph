"""Binding the API to microdot, and serving the app bundle. Pico only.

The thin layer that needs the real thing: sockets, a filesystem on SPI, and a
WiFi stack. What it could get wrong on its own — routes, argument checking,
error slugs — lives in `api.py`, where it is tested without any of that.

**One rule governs everything here: never `await` inside an SD transaction.**

asyncio on MicroPython is cooperative and single-threaded, so two tasks cannot
interleave inside a synchronous call. They can interleave at every `await`. The
`sdcard` driver is not reentrant, so an `await` part way through a block read
lets another task start its own SPI transaction on top — which is not a
corrupted file but a corrupted *bus*, and shows up as `timeout waiting for
response` and then `EIO`.

A browser fetching the bundle opens several connections at once and microdot
handles each as its own task, so this is not an edge case; it is the first
page load. The consequence is that static files are read whole and
synchronously rather than streamed, which is safe because they are small, ours,
and deployed by us. Gcode is the opposite of all three, so uploads are written
a chunk at a time — each write synchronous and atomic, with the `await` for the
next chunk outside it.
"""

try:
    from microdot import Microdot
except ImportError:  # pragma: no cover - desktop import, for reading
    Microdot = None

from server.api import Api, file_written
from store import StoreError


#: Where the app bundle lives on the card. A file copy puts it there; see
#: tools/deploy.py.
WWW_ROOT = "/sd/www"

#: Upload chunk size. Small enough that a Pico is never holding much, large
#: enough that the SD card is not written a byte at a time.
CHUNK_BYTES = 1024

#: A static file larger than this is refused rather than read into memory.
#: The bundle's biggest file is about 32 KB; anything approaching this is
#: something that should not be in `/www`.
MAX_STATIC_BYTES = 192 * 1024

#: How long a browser may keep a bundle file before asking again. Every
#: request is an SPI transaction competing with the plot, and the bundle only
#: changes when somebody deploys.
STATIC_CACHE_SECONDS = 600

#: Print a line per request to the serial console.
#:
#: On during bring-up, because the console is the only window into a machine
#: with no screen and "the page loads but nothing works" is indistinguishable
#: from a dozen causes without knowing what the browser asked for and what it
#: got. A page load is forty lines and then silence, since the bundle is
#: cached.
LOG_REQUESTS = True

CONTENT_TYPES = {
    "html": "text/html",
    "js": "text/javascript",
    "css": "text/css",
    "json": "application/json",
    "svg": "image/svg+xml",
    "ico": "image/x-icon",
    "png": "image/png",
    "woff2": "font/woff2",
}


def content_type(path):
    dot = path.rfind(".")
    extension = path[dot + 1:].lower() if dot >= 0 else ""

    return CONTENT_TYPES.get(extension, "application/octet-stream")


def safe_static_path(root, path):
    """The file a request is asking for, or None if it is asking for trouble."""
    if not path or path.endswith("/"):
        path = (path or "") + "index.html"

    # No climbing out of the bundle, and no absolute paths sneaking in.
    if ".." in path or path.startswith("/") or "\\" in path:
        return None

    return root + "/" + path


def read_static(root, path, max_bytes=MAX_STATIC_BYTES):
    """A bundle file, whole, in one synchronous read.

    Whole rather than streamed because streaming means `await` between block
    reads, and that is what lets two requests tangle their SPI transactions.
    Synchronous is the property that matters: nothing else can run until this
    returns.

    Returns `(bytes, content_type)`, or raises OSError when there is no such
    file — and refuses anything large enough to be a memory problem, which on
    a machine with a few hundred kilobytes is a real category.
    """
    full = safe_static_path(root, path)
    if full is None:
        raise OSError("that is not a path inside the bundle")

    import os

    size = os.stat(full)[6]
    if size > max_bytes:
        raise OSError("%s is %d bytes, too big to serve from here" % (full, size))

    with open(full, "rb") as handle:
        return handle.read(), content_type(full)


def log(*parts):  # pragma: no cover - a print
    if LOG_REQUESTS:
        print(" ".join(str(p) for p in parts))


#: The files the page cannot start without. index.html renders its header
#: whether or not these arrive — it is static markup — so their absence looks
#: like a working server and a broken app.
ESSENTIAL = ("index.html", "js/main.js", "js/ui/panels.js", "css/app.css")


def bundle_problems(root, exists):
    """Which of the essential files are not where they should be.

    Checked at boot rather than waiting for a browser, because the symptom at
    the far end — a page that loads with an unstyled header and three buttons
    that do nothing — points at everything except a half-copied card.

    `exists` is injected so this can be tested without a filesystem.
    """
    return [name for name in ESSENTIAL if not exists(root + "/" + name)]


def check_bundle(root):  # pragma: no cover - needs a filesystem
    """Report on the bundle at boot. Returns the missing files."""
    import os

    def exists(path):
        try:
            os.stat(path)
            return True
        except OSError:
            return False

    missing = bundle_problems(root, exists)

    if missing:
        print("the app bundle at %s is incomplete:" % root)
        for name in missing:
            print("  missing %s" % name)
        print("  run tools/deploy.py onto the card; the page will not work")
    else:
        print("app bundle present at %s" % root)

    return missing


def create(controller, www_root=WWW_ROOT):  # pragma: no cover - needs the Pico
    if Microdot is None:
        raise RuntimeError("microdot is only available on the Pico")

    app = Microdot()
    api = Api(controller)

    # --- upload -------------------------------------------------------------
    #
    # Its own route, ahead of the general one, because it is the only request
    # whose body must not be assembled. Everything else here has a body small
    # enough to hold.

    @app.route("/api/files/<name>", methods=["POST"])
    async def upload(request, name):
        try:
            writer = controller.store.open_write(name)
        except StoreError as refused:
            return {"error": refused.slug, "message": refused.message}, 400

        written = 0

        try:
            # microdot reads short bodies itself and leaves long ones on the
            # stream, so both have to be handled or a small file uploads as
            # nothing.
            if request.body:
                writer.write(request.body)
                written = len(request.body)
            else:
                while True:
                    chunk = await request.stream.read(CHUNK_BYTES)
                    if not chunk:
                        break

                    # Synchronous, so no other task can be on the bus during
                    # it. The await above is outside the transaction.
                    writer.write(chunk)
                    written += len(chunk)
        finally:
            writer.close()

        log("201", "POST", name, written, "bytes")

        # Shaped by api.py so this route and the tested one cannot drift.
        answer = file_written(name, written)
        return answer.body, answer.status

    # --- everything else on /api --------------------------------------------

    @app.route("/api/<path:rest>", methods=["GET", "POST", "PUT", "DELETE"])
    async def api_route(request, rest):
        body = request.json if request.method in ("POST", "PUT") else None
        result = api.handle(request.method, request.path, body)

        log(result.status, request.method, request.path)

        if result.body is None:
            return "", result.status

        return result.body, result.status

    # --- the bundle ---------------------------------------------------------

    @app.route("/")
    async def index(request):
        return _serve("index.html")

    @app.route("/<path:path>")
    async def static(request, path):
        return _serve(path)

    def _serve(path):
        try:
            body, kind = read_static(www_root, path)
        except OSError as missing:
            # The path is in the message on purpose. A generic 404 from an
            # embedded server sends people to check their wiring when the
            # answer is that one file did not make it onto the card.
            log("404", path, "-", missing)
            return {
                "error": "not_found",
                "message": "no %s in the bundle" % path,
            }, 404

        log("200", path, kind, len(body))

        return body, 200, {
            "Content-Type": kind,
            "Cache-Control": "max-age=%d" % STATIC_CACHE_SECONDS,
        }

    return app
