from __future__ import annotations

import logging
import signal
import sys

from . import api, config
from .service import UsageService
from .store import Store


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cfg = config.load()
    svc = UsageService(cfg, Store(cfg.data_dir))
    svc.start_poller()
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        api.run(svc, cfg.host, cfg.port)
    finally:
        svc.stop()


if __name__ == "__main__":
    main()
