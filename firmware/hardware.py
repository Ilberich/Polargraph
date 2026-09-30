"""The pin map, and the peripherals hanging off it.

**This file is the pin map.** `docs/HARDWARE.md` describes it in prose for
somebody holding a soldering iron, but the numbers live here — a wiring
document that has drifted from the firmware is a bring-up session spent
chasing a fault that was never in the hardware.

Everything that touches a peripheral is guarded so the module imports on a
desktop. The functions then refuse rather than pretend: a `mount_sd` that
silently returned a temp directory would let the whole system look healthy
while storing a plot somewhere it will never be found.
"""

try:
    import machine
    import network
except ImportError:  # pragma: no cover - desktop import, for reading and tests
    machine = None
    network = None


# --- pins -------------------------------------------------------------------
#
# Avoid GP23, GP24, GP25 and GP29: committed to internal functions on the Pico W
# form factor (SMPS mode, VBUS sense, the wireless module).

#: Step pins, PIO-driven. Adjacent on purpose so the two state machines sit in
#: the same PIO block with consecutive `set` bases.
STEP_LEFT = 2
STEP_RIGHT = 3

#: Direction. Plain outputs: direction is only ever changed with the axis
#: stopped, so it does not need to be in the PIO data. See motion/pio.py.
DIR_LEFT = 4
DIR_RIGHT = 5

#: Shared driver enable, **active low**. One pin for both DRV8825s.
ENABLE = 6

#: DRV8825 nFAULT, one per driver. Inputs with pull-ups; low means trouble.
FAULT_LEFT = 7
FAULT_RIGHT = 8

#: Pause and resume. Switch to ground, internal pull-up.
PAUSE_BUTTON = 15

#: microSD over SPI0.
SD_MISO = 16
SD_CS = 17
SD_SCK = 18
SD_MOSI = 19

#: Reserved for v2's pen servo. Unused by NullPen (AD-2).
PEN_SERVO = 14

#: Where the card is mounted, and what lives on it.
SD_MOUNT = "/sd"

#: The board's own flash, for bring-up before a card is available. Empty
#: rather than a directory name because MicroPython mounts the internal
#: littlefs at `/`, so the paths come out as `/www` and `/gcode`.
#:
#: The bundle is 252 KB and fits easily; a plot file will not, which is the
#: whole reason the card exists. See `storage_paths`.
FLASH_ROOT = ""


def storage_paths(root=SD_MOUNT):
    """Where the three things the firmware needs live, under a given root.

    Taking a root rather than hardcoding `/sd` is what lets the server be
    brought up on internal flash while a card is in the post. It is a
    bring-up path, not a fallback: a plotter that quietly stored jobs on
    flash would work until the first drawing anybody cared about.
    """
    return {
        "www": root + "/www",
        "gcode": root + "/gcode",
        "config": root + "/config.json",
    }


#: The usual case, spelled out for the code that only ever wants the card.
WWW_DIR = SD_MOUNT + "/www"
GCODE_DIR = SD_MOUNT + "/gcode"
CONFIG_PATH = SD_MOUNT + "/config.json"


class HardwareError(Exception):
    """A peripheral that is not there, or not answering."""


def _require_micropython(what):
    if machine is None:
        raise HardwareError("%s needs the Pico" % what)


# --- storage ----------------------------------------------------------------

#: How many times to ask the card before giving up.
SD_ATTEMPTS = 6

#: How long to wait between goes, milliseconds.
SD_SETTLE_MS = 150


def bring_up_card(open_card, attempts=SD_ATTEMPTS, settle_ms=SD_SETTLE_MS,
                  sleep=None):
    """Ask the card to start, more than once, with a pause between goes.

    A card in SPI mode does not reliably answer the first time it is asked.
    The spec gives it a settling period after power is applied, and a soft
    reset does not power-cycle it — so the board can come back up and start
    talking to a card that is still part way through whatever it was doing.

    The difference is invisible at a REPL, where seconds pass between typing
    `import hardware` and typing `hardware.mount_sd()`, and reliable from a
    script, which gets there in milliseconds. That asymmetry is what makes
    this worth retrying rather than reporting: the card is fine, it was asked
    too early.

    `open_card` does the work and raises `OSError` when the card does not
    answer. Injected so the retrying can be tested without one.
    """
    if sleep is None:  # pragma: no cover - needs the Pico
        import time
        sleep = time.sleep_ms

    problem = None

    for attempt in range(attempts):
        if attempt:
            sleep(settle_ms)

        try:
            return open_card()
        except OSError as refused:
            problem = refused

    raise HardwareError(
        "no SD card after %d attempts: %s" % (attempts, problem))


def mount_sd(mount=SD_MOUNT, attempts=SD_ATTEMPTS):  # pragma: no cover - needs the Pico
    """Mount the card, and make sure the directories the firmware needs exist.

    Raises rather than falling back. A plotter that cannot reach its card has
    nothing to plot, and pretending otherwise only moves the failure to
    somewhere less obvious.
    """
    _require_micropython("the SD card")

    import os
    import sdcard

    # A soft reset leaves the mount table alone while destroying the driver
    # object behind it, so anything still mounted here is a stale entry from
    # the last run and has to go before the card can be opened again.
    try:
        os.umount(mount)
    except OSError:
        pass

    # Probed slowly on purpose: a card must be addressed at 100-400 kHz until
    # it has answered, and only then sped up.
    spi = machine.SPI(
        0,
        baudrate=1_000_000,
        sck=machine.Pin(SD_SCK),
        mosi=machine.Pin(SD_MOSI),
        miso=machine.Pin(SD_MISO),
    )

    # Held high between attempts, which is where a card expects to see it
    # while it is being clocked into a known state.
    chip_select = machine.Pin(SD_CS, machine.Pin.OUT, value=1)

    def open_card():
        card = sdcard.SDCard(spi, chip_select)
        os.mount(card, mount)
        return card

    bring_up_card(open_card, attempts)

    # Faster now the card has answered at the rate it had to be probed at.
    spi.init(baudrate=12_000_000)

    make_directories(mount)

    return mount


def make_directories(root):  # pragma: no cover - needs a filesystem to make
    """The directories the firmware expects, wherever it has been pointed."""
    import os

    paths = storage_paths(root)

    for directory in (paths["www"], paths["gcode"]):
        try:
            os.mkdir(directory)
        except OSError:
            pass  # already there, which is the usual case

    return paths


# --- network ----------------------------------------------------------------

def connect_wifi(ssid, password, hostname="polargraph", timeout_s=20):  # pragma: no cover
    """Join the network, and answer to `<hostname>.local`.

    The hostname is set before activating the interface, because mDNS
    advertises whatever the interface was brought up with — setting it
    afterwards leaves the plotter answering to `PYBD` or nothing at all, and
    AD-1 has the user typing that name into a browser.
    """
    _require_micropython("WiFi")

    if not ssid:
        raise HardwareError("no WiFi network configured; write config.json")

    network.hostname(hostname)

    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    wlan.connect(ssid, password)

    import time

    deadline = time.ticks_add(time.ticks_ms(), int(timeout_s * 1000))

    while not wlan.isconnected():
        if time.ticks_diff(deadline, time.ticks_ms()) <= 0:
            raise HardwareError("could not join %r in %ds" % (ssid, timeout_s))

        time.sleep_ms(200)

    return wlan.ifconfig()[0]


# --- drivers ----------------------------------------------------------------

def fault_pins():  # pragma: no cover - needs the Pico
    """The two nFAULT lines, as inputs that read True when the driver is upset."""
    _require_micropython("the driver fault lines")

    left = machine.Pin(FAULT_LEFT, machine.Pin.IN, machine.Pin.PULL_UP)
    right = machine.Pin(FAULT_RIGHT, machine.Pin.IN, machine.Pin.PULL_UP)

    return (lambda: not left.value(), lambda: not right.value())
