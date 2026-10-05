from dataclasses import dataclass
from urllib.parse import urlsplit

LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def local_host(value: str) -> bool:
    try:
        parsed = urlsplit("http://" + value)
        return (parsed.hostname in LOOPBACK_HOSTS and not parsed.username
                and not parsed.password and not parsed.path and not parsed.query
                and not parsed.fragment and parsed.port != 0)
    except ValueError:
        return False


@dataclass(frozen=True)
class OriginPolicy:
    allowed: tuple[str, ...]

    @classmethod
    def local(cls, configured: str = ""):
        origins = tuple(x.strip() for x in configured.split(",") if x.strip()) or (
            "http://localhost:5173", "http://127.0.0.1:5173",
            "http://localhost:5175", "http://127.0.0.1:5175",
        )
        for origin in origins:
            parsed = urlsplit(origin)
            if parsed.scheme not in {"http", "https"} or not local_host(parsed.netloc) or parsed.path or parsed.query or parsed.fragment:
                raise ValueError("Local origins must be explicit loopback origins")
        return cls(origins)

    @classmethod
    def demo(cls, configured: str = "https://openbutler.vercel.app"):
        origins = tuple(x.strip() for x in configured.split(",") if x.strip())
        for origin in origins:
            parsed = urlsplit(origin)
            if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
                raise ValueError("Demo origins must be explicit HTTPS origins")
        return cls(origins)

    def accepts(self, origin: str | None) -> bool:
        # Electron uses a main-process proxy, not file:// or opaque Origin access.
        return origin is None or origin in self.allowed
