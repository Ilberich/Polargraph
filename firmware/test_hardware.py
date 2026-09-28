import unittest

import hardware


class Paths(unittest.TestCase):
    def test_the_card_is_where_everything_normally_lives(self):
        paths = hardware.storage_paths()

        self.assertEqual(paths["www"], "/sd/www")
        self.assertEqual(paths["gcode"], "/sd/gcode")
        self.assertEqual(paths["config"], "/sd/config.json")

    def test_flash_paths_land_at_the_root(self):
        # MicroPython mounts the internal littlefs at `/`, so the bring-up
        # root is empty rather than a directory name.
        paths = hardware.storage_paths(hardware.FLASH_ROOT)

        self.assertEqual(paths["www"], "/www")
        self.assertEqual(paths["gcode"], "/gcode")
        self.assertEqual(paths["config"], "/config.json")


class OffTarget(unittest.TestCase):
    """The peripheral calls refuse rather than pretend.

    A `mount_sd` that quietly returned a temp directory would let the whole
    system look healthy while storing a plot somewhere it will never be found.
    """

    def test_the_card_needs_the_pico(self):
        with self.assertRaises(hardware.HardwareError):
            hardware.mount_sd()

    def test_wifi_needs_the_pico(self):
        with self.assertRaises(hardware.HardwareError):
            hardware.connect_wifi("net", "pass")

    def test_the_fault_lines_need_the_pico(self):
        with self.assertRaises(hardware.HardwareError):
            hardware.fault_pins()


class PinMap(unittest.TestCase):
    def test_the_step_pins_are_adjacent(self):
        # So the two state machines sit in the same PIO block with consecutive
        # set bases. Verified on hardware.
        self.assertEqual(hardware.STEP_RIGHT, hardware.STEP_LEFT + 1)

    def test_nothing_uses_a_pin_the_pico_w_has_committed(self):
        # GP23, GP24, GP25 and GP29 are SMPS mode, VBUS sense and the wireless
        # module on this form factor.
        reserved = {23, 24, 25, 29}
        used = {
            hardware.STEP_LEFT, hardware.STEP_RIGHT,
            hardware.DIR_LEFT, hardware.DIR_RIGHT,
            hardware.ENABLE, hardware.FAULT_LEFT, hardware.FAULT_RIGHT,
            hardware.PAUSE_BUTTON, hardware.PEN_SERVO,
            hardware.SD_MISO, hardware.SD_CS, hardware.SD_SCK, hardware.SD_MOSI,
        }

        self.assertEqual(used & reserved, set())

    def test_no_pin_is_used_twice(self):
        pins = [
            hardware.STEP_LEFT, hardware.STEP_RIGHT,
            hardware.DIR_LEFT, hardware.DIR_RIGHT,
            hardware.ENABLE, hardware.FAULT_LEFT, hardware.FAULT_RIGHT,
            hardware.PAUSE_BUTTON, hardware.PEN_SERVO,
            hardware.SD_MISO, hardware.SD_CS, hardware.SD_SCK, hardware.SD_MOSI,
        ]

        self.assertEqual(len(pins), len(set(pins)))


if __name__ == "__main__":
    unittest.main()
