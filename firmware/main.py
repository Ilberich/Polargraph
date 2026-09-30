"""Boot.

The order matters and each step is a different kind of failure:

1. **Card first.** Everything else is on it — the config, the app bundle, the
   gcode. A plotter with no card has nothing to be.
2. **Config, then WiFi.** The credentials are on the card, so this cannot come
   earlier.
3. **Motion last, and disabled.** The drivers stay off until something asks
   for a move. They are powered for holding torque while plotting and warm
   while doing it, so leaving them energised from boot is heat for nothing.

Then asyncio: the web server and the motion loop as two tasks. That split is
what AD-4 buys — PIO owns pulse timing, so a few milliseconds of scheduler
latency delays the *next* segment being queued rather than disturbing the line
being drawn. A 1 mm segment at 20 mm/s lasts 50 ms, which is a very long time
to a scheduler with two tasks on it.

If anything here fails the board keeps running and says why over serial, rather
than dropping to a REPL a user standing at a plotter cannot see.
"""

import sys

import hardware
from button import gpio_pause_button
from config import Config
from controller import Controller
from motion.pen import NullPen
from motion.pio import PioBackend
from motion.stepper import Stepper
from server.app import create
from store import Store
from supervisor import Supervisor


def build(root=None):
    """Everything wired together, or an exception saying what was missing.

    `root` points the firmware at somewhere other than the SD card — the
    board's own flash, during bring-up, while a card is in the post. It is a
    bring-up path and not a fallback: the bundle fits in flash and a plot file
    does not, so a plotter that quietly stored jobs there would work right up
    until the first drawing anybody cared about.
    """
    if root is None:
        root = hardware.mount_sd()

    paths = hardware.storage_paths(root)

    config = Config.load(paths["config"])
    address = hardware.connect_wifi(
        config["ssid"], config["password"], config["hostname"])

    backend = PioBackend(
        hardware.STEP_LEFT, hardware.STEP_RIGHT,
        hardware.DIR_LEFT, hardware.DIR_RIGHT,
        hardware.ENABLE,
    )
    backend.enable(False)

    pen = NullPen()
    stepper = Stepper(backend, pen)

    store = Store(paths["gcode"])
    controller = Controller(store, config, stepper, pen)

    supervisor = Supervisor(
        controller,
        button=gpio_pause_button(hardware.PAUSE_BUTTON),
        faults=hardware.fault_pins(),
    )

    return controller, supervisor, address, paths


async def motion_loop(supervisor):  # pragma: no cover - needs the Pico
    """Advance the job, forever, yielding between slices."""
    import asyncio

    while True:
        busy = supervisor.step()

        # Idle: nothing to do but watch the button, and no reason to spin.
        await asyncio.sleep_ms(0 if busy else 20)


def run(root=None):  # pragma: no cover - needs the Pico
    import asyncio

    controller, supervisor, address, paths = build(root)
    app = create(controller, paths["www"])

    print("polargraph up at http://%s (%s.local)" % (address, controller.config["hostname"]))
    print("position is not trusted until it is homed")

    async def serve():
        asyncio.create_task(motion_loop(supervisor))
        await app.start_server(port=80)

    asyncio.run(serve())


if __name__ == "__main__":
    try:
        run()
    except Exception as problem:  # noqa: BLE001 - the last line of defence
        # A plotter has no screen. Dropping to a REPL tells a user standing at
        # the machine nothing at all, so say it and keep saying it — but say
        # the whole thing once, and only a reminder after that. A traceback
        # repeated every ten seconds buries itself.
        if hasattr(sys, "print_exception"):
            sys.print_exception(problem)

        print("polargraph did not start: %s" % problem)
        print("fix it and reset the board; Ctrl-C for a REPL")

        import time

        while True:
            time.sleep(30)
            print("polargraph is not running: %s" % problem)
