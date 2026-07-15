class MineContextError(RuntimeError):
    """Base error for MineContext integration failures."""


class MineContextUnavailable(MineContextError):
    """MineContext is not installed or cannot be reached."""


class GodviewScriptError(MineContextError):
    """The godview wrapper failed, timed out, or produced invalid output."""
