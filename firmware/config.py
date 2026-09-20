"""`config.json` on the SD card.

**WiFi credentials only.** Every other setting travels with the job, because a
plotter that remembers a paper size is a plotter that will one day draw on the
wrong paper without being asked. Keeping this file to the one thing that cannot
travel with a job is what stops it growing into a second source of truth.

The file is gitignored and has never been committed.
"""

import json


DEFAULTS = {
    "ssid": "",
    "password": "",
    "hostname": "polargraph",
}

#: Never leaves the machine. `GET /api/config` omits it.
SECRET_KEYS = ("password",)


class Config:
    def __init__(self, path, values=None):
        self.path = path
        self.values = dict(DEFAULTS)

        if values is not None:
            self.values.update(values)

    @classmethod
    def load(cls, path):
        """Read the file, or start from defaults if there is not one yet.

        A missing or unreadable config is not an error worth refusing to boot
        over: the machine comes up on its defaults and the app can write a real
        one over the network.
        """
        config = cls(path)

        try:
            with open(path) as handle:
                stored = json.load(handle)
        except (OSError, ValueError):
            return config

        if isinstance(stored, dict):
            config.merge(stored)

        return config

    def merge(self, changes):
        """Apply a partial update, ignoring keys that are not ours."""
        for key in DEFAULTS:
            if key in changes and changes[key] is not None:
                self.values[key] = changes[key]

        return self.values

    def save(self):
        with open(self.path, "w") as handle:
            json.dump(self.values, handle)

    def public(self):
        """What may be sent to the app: everything but the secrets."""
        return {k: v for k, v in self.values.items() if k not in SECRET_KEYS}

    def __getitem__(self, key):
        return self.values[key]
