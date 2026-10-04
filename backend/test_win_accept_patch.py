"""A dropped client during accept is retried; other accept errors still surface."""
import asyncio
import sys
import unittest

import win_accept_patch


def _winerror(code):
    exc = OSError(22, "dropped")
    exc.winerror = code
    return exc


@unittest.skipUnless(sys.platform == "win32", "Proactor accept is Windows-only")
class AcceptPatchTest(unittest.TestCase):
    def setUp(self):
        from asyncio import windows_events
        self.proactor = windows_events.IocpProactor
        self.saved = self.proactor.accept

    def tearDown(self):
        self.proactor.accept = self.saved

    def _run(self, outcomes):
        """Install the patch over a fake accept that yields `outcomes` in turn."""
        loop = asyncio.new_event_loop()
        calls = []

        def fake_accept(proactor_self, listener):
            f = loop.create_future()
            outcome = outcomes[len(calls)]
            calls.append(outcome)
            if isinstance(outcome, BaseException):
                loop.call_soon(f.set_exception, outcome)
            else:
                loop.call_soon(f.set_result, outcome)
            return f

        fake_accept._survives_dropped_clients = False
        self.proactor.accept = fake_accept
        win_accept_patch.install()
        holder = type("P", (), {"_loop": loop})()
        try:
            fut = self.proactor.accept(holder, object())
            try:
                return loop.run_until_complete(fut), calls
            except OSError as exc:
                return exc, calls
        finally:
            loop.close()

    def test_dropped_client_is_retried(self):
        result, calls = self._run([_winerror(64), ("conn", "addr")])
        self.assertEqual(result, ("conn", "addr"))
        self.assertEqual(len(calls), 2)

    def test_other_errors_pass_through(self):
        result, calls = self._run([_winerror(10038)])
        self.assertIsInstance(result, OSError)
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
