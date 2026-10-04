"""Keep a Windows asyncio server listening when a client drops mid-accept.

On Windows the Proactor loop accepts connections with AcceptEx. When a client
gives up while that accept is still completing, the accept fails with
WinError 64 ("the specified network name is no longer available"), and
asyncio's serving loop treats any accept error as fatal: it logs "Accept failed
on a socket" and closes the listening socket. The process keeps running and
connections that were already open keep working, but every new connection is
refused. That took the backend on :8003 down on 2026-09-28 22:50.

install() wraps IocpProactor.accept so that a failed accept with one of these
errors is dropped and the next accept is issued in its place; the serving loop
never sees the error. Other errors are passed through unchanged.
"""
import sys

# 64: ERROR_NETNAME_DELETED -- the client went away during AcceptEx.
_DROPPED_CLIENT = {64}


def install() -> None:
    if sys.platform != "win32":
        return
    from asyncio import windows_events

    proactor = windows_events.IocpProactor
    if getattr(proactor.accept, "_survives_dropped_clients", False):
        return
    original = proactor.accept

    def accept(self, listener):
        outer = self._loop.create_future()
        current = []

        def attempt():
            inner = original(self, listener)
            current[:] = [inner]

            def done(f):
                if outer.done():
                    return
                if f.cancelled():
                    outer.cancel()
                    return
                exc = f.exception()
                if isinstance(exc, OSError) and getattr(exc, "winerror", None) in _DROPPED_CLIENT:
                    attempt()
                elif exc is not None:
                    outer.set_exception(exc)
                else:
                    outer.set_result(f.result())

            inner.add_done_callback(done)

        def cancel_inner(f):
            if f.cancelled() and current and not current[0].done():
                current[0].cancel()

        outer.add_done_callback(cancel_inner)
        attempt()
        return outer

    accept._survives_dropped_clients = True
    proactor.accept = accept
