"""The pen axis, and the absence of one.

AD-2: Z is a continuous axis from day one. v1 has no pen hardware, so `NullPen`
accepts depths, reports them in status, and moves nothing. That is not a stub to
be replaced later — it is the v1 implementation, and it is what makes v1 files
forward-compatible with v2 hardware rather than something to be re-exported.

Anything that drives a real pen implements the same three methods.
"""


class PenAxis:
    """What a pen has to be able to do.

    ``move_to`` is given the depth the gondola should be at by the end of the
    segment and how long that segment takes, so a servo can be commanded to
    arrive with the move rather than lurching at each vertex.
    """

    def move_to(self, z_mm, seconds):
        raise NotImplementedError

    def position_mm(self):
        raise NotImplementedError

    def park(self):
        """Lift clear of the paper. Called when a job ends or is stopped."""
        raise NotImplementedError


class NullPen(PenAxis):
    """v1: there is no pen axis, and pretending otherwise would be a lie.

    It remembers the depth it was asked for so status reports the truth — the
    file said -1.5 mm and the machine is at -1.5 mm as far as it is concerned —
    and it never claims to have parked.
    """

    #: There is no hardware, so nothing can be lifted off the paper.
    can_lift = False

    def __init__(self):
        self._z_mm = 0.0

    def move_to(self, z_mm, seconds=0.0):
        self._z_mm = float(z_mm)

    def position_mm(self):
        return self._z_mm

    def park(self):
        """Nothing to park. The pen stays exactly where it is touching."""
