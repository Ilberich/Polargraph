"""The REST API, as a function rather than a framework.

`docs/API.md` is the contract. Everything here is plain dispatch — method, path,
body in; status and a dictionary out — with no web framework anywhere near it.
`app.py` binds it to microdot on the Pico.

The same reason the PIO driver is split: what the API could get wrong is route
matching, argument checking and error slugs, and none of that needs a socket.
What a framework contributes is sockets.
"""

from store import StoreError
from controller import ControllerError


class Response:
    __slots__ = ("status", "body")

    def __init__(self, status, body=None):
        self.status = status
        self.body = body

    def __repr__(self):
        return "Response(%d, %r)" % (self.status, self.body)


def error(status, slug, message):
    """The shape every failure takes. See docs/API.md, Conventions."""
    return Response(status, {"error": slug, "message": message})


class Api:
    """Routes, bound to one machine."""

    def __init__(self, controller):
        self.controller = controller

    # --- dispatch -----------------------------------------------------------

    def handle(self, method, path, body=None, stream=None):
        """One request.

        ``body`` is a decoded JSON object for the endpoints that take one.
        ``stream`` is an iterable of byte chunks, for upload — kept separate
        and never decoded, because a plot file must not be held in memory.
        """
        if not path.startswith("/api/"):
            return error(404, "not_found", "no such endpoint")

        parts = [p for p in path[len("/api/"):].split("/") if p]

        try:
            return self._route(method, parts, body, stream)
        except ControllerError as refusal:
            return error(refusal.status, refusal.slug, refusal.message)
        except StoreError as refusal:
            status = 404 if refusal.slug == "not_found" else 400
            return error(status, refusal.slug, refusal.message)

    def _route(self, method, parts, body, stream):
        if not parts:
            return error(404, "not_found", "no such endpoint")

        head = parts[0]

        if head == "status" and len(parts) == 1:
            return self._status(method)
        if head == "config" and len(parts) == 1:
            return self._config(method, body)
        if head == "files":
            return self._files(method, parts[1:], stream)
        if head == "job":
            return self._job(method, parts[1:], body)
        if head == "jog" and len(parts) == 1:
            return self._jog(method, body)
        if head == "position" and parts[1:] == ["seed"]:
            return self._seed(method, body)
        if head == "calibration":
            # Phase 6. Documented, so a 404 would be misleading about whether
            # the endpoint exists — it does, it is just not built yet.
            return error(501, "not_implemented",
                         "calibration arrives in Phase 6")

        return error(404, "not_found", "no such endpoint")

    # --- endpoints ----------------------------------------------------------

    def _status(self, method):
        if method != "GET":
            return _wrong_method("GET")

        return Response(200, self.controller.status())

    def _config(self, method, body):
        config = self.controller.config

        if method == "GET":
            return Response(200, config.public())

        if method == "PUT":
            if not isinstance(body, dict):
                return error(400, "bad_body", "a JSON object is required")

            config.merge(body)
            config.save()

            # Never echo the password back, even to the client that set it.
            return Response(200, config.public())

        return _wrong_method("GET, PUT")

    def _files(self, method, rest, stream):
        store = self.controller.store

        if not rest:
            if method != "GET":
                return _wrong_method("GET")

            return Response(200, {"files": store.list()})

        if len(rest) > 1:
            return error(404, "not_found", "no such endpoint")

        name = rest[0]

        if method == "POST":
            if stream is None:
                return error(400, "bad_body", "the request body is the gcode")

            # Chunk by chunk onto the card. Nothing here ever sees the file.
            writer = store.open_write(name)
            try:
                for chunk in stream:
                    writer.write(chunk)
            finally:
                written = writer.close()

            return Response(201, {"name": name, "bytes": written})

        if method == "DELETE":
            if self.controller.job_file == name and self.controller.job is not None:
                return error(409, "job_running", "that file is the active job")

            store.delete(name)
            return Response(204)

        return _wrong_method("POST, DELETE")

    def _job(self, method, rest, body):
        if len(rest) != 1 or rest[0] not in ("start", "pause", "resume", "stop"):
            return error(404, "not_found", "no such endpoint")

        # The action exists; it is the method that is wrong. Saying so is more
        # use than a blanket 404.
        if method != "POST":
            return _wrong_method("POST")

        action = rest[0]
        controller = self.controller

        if action == "start":
            if not isinstance(body, dict) or not body.get("file"):
                return error(400, "bad_body", "a file name is required")

            return Response(200, controller.start(body["file"], body.get("settings")))

        if action == "pause":
            return Response(200, controller.pause())
        if action == "resume":
            return Response(200, controller.resume())
        return Response(200, controller.stop())

    def _jog(self, method, body):
        if method != "POST":
            return _wrong_method("POST")

        if not isinstance(body, dict):
            return error(400, "bad_body", "a JSON object is required")

        return Response(200, self.controller.jog(
            _number(body, "dx", 0.0),
            _number(body, "dy", 0.0),
            body.get("feed"),
        ))

    def _seed(self, method, body):
        if method != "POST":
            return _wrong_method("POST")

        if not isinstance(body, dict):
            return error(400, "bad_body", "a JSON object is required")

        for required in ("motorSpacing", "dropFromMotorLine"):
            if required not in body:
                return error(400, "bad_body", "%s is required" % required)

        return Response(200, self.controller.seed(
            body.get("reference", "center"),
            float(body["motorSpacing"]),
            float(body["dropFromMotorLine"]),
            body.get("paperSize"),
        ))


def _wrong_method(allowed):
    return error(405, "method_not_allowed", "this endpoint takes %s" % allowed)


def _number(body, key, default):
    value = body.get(key, default)

    try:
        return float(value)
    except (TypeError, ValueError):
        raise ControllerError("bad_body", "%s must be a number" % key, 400)
