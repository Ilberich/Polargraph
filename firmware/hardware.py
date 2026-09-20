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
WWW_DIR = SD_MOUNT + "/www"
GCODE_DIR = SD_MOUNT + "/gcode"
CONFIG_PATH = SD_MOUNT + "/config.json"


class HardwareError(Exception):
    """A peripheral that is not there, or not answering."""


def _require_micropython(what):
    if machine is None:
        raise HardwareError("%s needs the Pico" % what)


# --- storage ----------------------------------------------------------------

def mount_sd(mount=SD_MOUNT):  # pragma: no cover - needs the Pico
    """Mount the card, and make sure the directories the firmware needs exist.

    Raises rather than falling back. A plotter that cannot reach its card has
    nothing to plot, and pretending otherwise only moves the failure to
    somewhere less obvious.
    """
    _require_micropython("the SD card")

    import os
    import sdcard

    spi = machine.SPI(
        0,
        baudrate=1_000_000,
        sck=machine.Pin(SD_SCK),
        mosi=machine.Pin(SD_MOSI),
        miso=machine.Pin(SD_MISO),
    )

    try:
        card = sdcard.SDCard(spi, machine.Pin(SD_CS, machine.Pin.OUT))
        os.mount(card, mount)
    except OSError as problem:
        raise HardwareError("no SD card: %s" % problem)

    # Faster once the card has answered at the slow rate it must be probed at.
    spi.init(baudrate=12_000_000)

    for directory in (mount + "/www", mount + "/gcode"):
        try:
            os.mkdir(directory)
        except OSError:
            pass  # already there, which is the usual case

    return mount


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
