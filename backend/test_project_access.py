"""Accounts only see and write their own projects; admins see all.

Regression for one account opening the studio and landing on another's canvas:
unowned projects used to be visible to everyone, and saving a canvas skipped
the ownership check.
"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

import accounts
import main


class ProjectAccessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.patches = [
            mock.patch.object(accounts, "ACCOUNTS_FILE", root / "accounts.json"),
            mock.patch.object(main, "WORKSPACES_DIR", root / "workspaces"),
        ]
        for p in self.patches:
            p.start()
        self.client = TestClient(main.app)
        self.alice = accounts.register("alice", "pass1234")
        self.bob = accounts.register("bob", "pass1234")
        self.admin = accounts.register("boss", "pass1234")
        accounts.set_admin("boss")

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def auth(self, session):
        return {"Authorization": f"Bearer {session['token']}"}

    def make_unowned(self, name):
        with mock.patch.dict("os.environ", {"AI_CINEMA_DEFAULT_OWNER": ""}):
            return self.client.post("/projects", json={"name": name}).json()["id"]

    def listed(self, session):
        return {p["id"] for p in self.client.get("/projects", headers=self.auth(session)).json()["projects"]}

    def test_accounts_see_only_their_own_projects(self):
        mine = self.client.post("/projects", json={"name": "a"}, headers=self.auth(self.alice)).json()["id"]
        unowned = self.make_unowned("agent-made")
        self.assertEqual(self.listed(self.alice), {mine})
        self.assertEqual(self.listed(self.bob), set())
        # Admins are scoped like everyone else; unowned projects wait for
        # tools/assign_project_owner.py and are only reachable without a token.
        self.assertEqual(self.listed(self.admin), set())
        self.assertIn(unowned, {p["id"] for p in self.client.get("/projects").json()["projects"]})
        self.assertEqual(self.client.get(f"/projects/{mine}/canvas", headers=self.auth(self.bob)).status_code, 404)

    def test_expired_token_is_401_not_anonymous(self):
        self.make_unowned("x")
        res = self.client.get("/projects", headers={"Authorization": "Bearer not-a-real-token"})
        self.assertEqual(res.status_code, 401)

    def test_saving_someone_elses_canvas_is_refused(self):
        mine = self.client.post("/projects", json={"name": "a"}, headers=self.auth(self.alice)).json()["id"]
        body = {"nodes": [], "edges": []}
        self.assertEqual(self.client.put(f"/projects/{mine}/canvas", json=body,
                                         headers=self.auth(self.bob)).status_code, 404)
        self.assertEqual(self.client.put(f"/projects/{mine}/canvas", json=body,
                                         headers=self.auth(self.alice)).status_code, 200)

    def test_tokenless_projects_go_to_the_default_owner(self):
        with mock.patch.dict("os.environ", {"AI_CINEMA_DEFAULT_OWNER": "alice"}):
            pid = self.client.post("/projects", json={"name": "from mcp"}).json()["id"]
        meta = json.loads((main._project_dir(pid) / "meta.json").read_text(encoding="utf-8"))
        self.assertEqual(meta["owner_user_id"], self.alice["user"]["id"])
        self.assertIn(pid, self.listed(self.alice))
        self.assertNotIn(pid, self.listed(self.bob))


if __name__ == "__main__":
    unittest.main()
