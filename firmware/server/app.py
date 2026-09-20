"""Binding the API to microdot, and serving the app bundle. Pico only.

**Unverified against hardware.** Like `motion/pio.py`, this is the thin layer
that needs the real thing: sockets, a filesystem on SPI, and a WiFi stack. What
it could get wrong on its own — routes, argument checking, error slugs — lives
in `api.py`, where it is tested without any of that.

Two responsibilities:

* `/api/...` goes to the `Api` object, with the upload path kept as a stream of
  chunks so a plot file never lands in RAM.
* Everything else is a file off the card, which is AD-1's other deploy target:
  the same bundle GitHub Pages serves, so page and API are same-origin plain
  HTTP and there is no mixed content and no CORS.
"""

try:
    from microdot import Microdot, Response as MicrodotResponse
except ImportError:  # pragma: no cover - desktop import, for reading
    Microdot = None
    MicrodotResponse = None

from server.api import Api


#: Where the app bundle lives on the card. A file copy puts it there; see
#: tools/deploy.py.
WWW_ROOT = "/sd/www"

#: Upload chunk size. Small enough that a Pico is never holding much, large
#: enough that the SD card is not written a byte at a time.
CHUNK_BYTES = 1024

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


def chunks(request, size=CHUNK_BYTES):
    """The request body as a stream, never as a string.

    microdot will hand over a whole body if asked; this asks for pieces
    instead, because a plot file is larger than the memory available to hold
    one.
    """
    while True:
        chunk = request.stream.read(size)
        if not chunk:
            return

        yield chunk


def create(controller, www_root=WWW_ROOT):  # pragma: no cover - needs the Pico
    if Microdot is None:
        raise RuntimeError("microdot is only available on the Pico")

    app = Microdot()
    api = Api(controller)

    @app.route("/api/<path:rest>", methods=["GET", "POST", "PUT", "DELETE"])
    def api_route(request, rest):
        # Only an upload streams; everything else has a small JSON body.
        stream = chunks(request) if request.method == "POST" else None
        body = request.json if stream is None else None

        result = api.handle(request.method, request.path, body, stream)

        if result.body is None:
            return "", result.status

        return result.body, result.status

    @app.route("/")
    def index(request):
        return _file(www_root + "/index.html")

    @app.route("/<path:path>")
    def static(request, path):
        if ".." in path:
            return {"error": "not_found", "message": "no such file"}, 404

        return _file(www_root + "/" + path)

    def _file(path):
        try:
            return MicrodotResponse.send_file(path, content_type=content_type(path))
        except OSError:
            return {"error": "not_found", "message": "no such file"}, 404

    return app
