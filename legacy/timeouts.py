import threading


def run_with_timeout(fn, timeout_sec: float, label: str):
    holder = {}

    def worker():
        try:
            holder["value"] = fn()
        except Exception as exc:
            holder["error"] = exc

    thread = threading.Thread(target=worker, daemon=True, name=f"timeout-{label}")
    thread.start()
    thread.join(timeout_sec)
    if thread.is_alive():
        raise TimeoutError(f"{label} timed out after {timeout_sec}s")
    if "error" in holder:
        raise holder["error"]
    if "value" not in holder:
        raise TimeoutError(f"{label} returned no result")
    return holder["value"]
