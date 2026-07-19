import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("AGENT_TOKEN", "test-token")
MODULE_PATH = Path(__file__).with_name("agent.py")
SPEC = importlib.util.spec_from_file_location("dn42_peering_agent", MODULE_PATH)
agent = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agent)


class RemovePeerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.wg_dir = base / "wireguard"
        self.bird_dir = base / "bird"
        self.wg_dir.mkdir()
        self.bird_dir.mkdir()
        self.state_file = base / "peers.json"
        self.old_conf = dict(agent.CONF)
        self.old_state_file = agent.STATE_FILE
        agent.CONF["wg_dir"] = str(self.wg_dir)
        agent.CONF["bird_peer_dir"] = str(self.bird_dir)
        agent.STATE_FILE = self.state_file
        self.asn = 4242421234
        self.wg_conf = self.wg_dir / "dn42-1234.conf"
        self.bird_conf = self.bird_dir / "dn42_1234.conf"
        managed = "# managed by dn42-peering agent - do not edit\n"
        self.wg_conf.write_text(managed + "[Interface]\n")
        self.bird_conf.write_text(managed + "protocol bgp dn42_1234 {}\n")
        self.state_file.write_text(json.dumps({str(self.asn): {"asn": self.asn}}))

    def tearDown(self):
        agent.CONF.clear()
        agent.CONF.update(self.old_conf)
        agent.STATE_FILE = self.old_state_file
        self.temp.cleanup()

    @staticmethod
    def successful_run(cmd, check=True, timeout=60):
        stdout = "Reconfigured\n" if cmd[:2] == ["birdc", "configure"] else ""
        return subprocess.CompletedProcess(cmd, 0, stdout=stdout, stderr="")

    def test_removes_files_and_state_after_bird_accepts_config(self):
        with patch.object(agent, "run", self.successful_run):
            agent.remove_peer(self.asn)
        self.assertFalse(self.wg_conf.exists())
        self.assertFalse(self.bird_conf.exists())
        self.assertEqual(json.loads(self.state_file.read_text()), {})

    def test_restores_files_and_state_when_bird_rejects_config(self):
        def rejected_run(cmd, check=True, timeout=60):
            stdout = "Reconfiguration failed\n" if cmd[:2] == ["birdc", "configure"] else ""
            return subprocess.CompletedProcess(cmd, 0, stdout=stdout, stderr="")

        with patch.object(agent, "run", rejected_run):
            with self.assertRaisesRegex(RuntimeError, "bird rejected config"):
                agent.remove_peer(self.asn)
        self.assertTrue(self.wg_conf.exists())
        self.assertTrue(self.bird_conf.exists())
        self.assertIn(str(self.asn), json.loads(self.state_file.read_text()))

    def test_refuses_to_remove_an_unmanaged_collision(self):
        self.wg_conf.write_text("# manually managed\n")
        with patch.object(agent, "run", self.successful_run):
            with self.assertRaisesRegex(agent.Conflict, "unmanaged WireGuard"):
                agent.remove_peer(self.asn)
        self.assertTrue(self.wg_conf.exists())
        self.assertTrue(self.bird_conf.exists())


class RenamePeerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.wg_dir = base / "wireguard"
        self.bird_dir = base / "bird"
        self.wg_dir.mkdir()
        self.bird_dir.mkdir()
        self.state_file = base / "peers.json"
        self.old_conf = dict(agent.CONF)
        self.old_state_file = agent.STATE_FILE
        agent.CONF["wg_dir"] = str(self.wg_dir)
        agent.CONF["bird_peer_dir"] = str(self.bird_dir)
        agent.STATE_FILE = self.state_file
        self.asn = 4242421234
        self.legacy_wg = self.wg_dir / "dn42-1234.conf"
        self.legacy_bird = self.bird_dir / "dn42_1234.conf"
        self.full_wg = self.wg_dir / "dn42-4242421234.conf"
        self.full_bird = self.bird_dir / "dn42_4242421234.conf"
        managed = "# managed by dn42-peering agent - do not edit\n"
        self.legacy_wg.write_text(managed + "[Interface]\nListenPort = 21234\n")
        self.legacy_bird.write_text(managed + "protocol bgp dn42_1234 {}\n")
        self.state_file.write_text(json.dumps({str(self.asn): {
            "asn": self.asn, "iface": "dn42-1234", "bgp_proto": "dn42_1234",
        }}))
        self.spec = {
            "asn": self.asn,
            "iface": "dn42-4242421234",
            "bgp_proto": "dn42_4242421234",
            "wg_port": 21234,
            "peer_pubkey": "A" * 43 + "=",
            "peer_ll": "fe80::1234",
            "our_ll": "fe80::1",
        }

    def tearDown(self):
        agent.CONF.clear()
        agent.CONF.update(self.old_conf)
        agent.STATE_FILE = self.old_state_file
        self.temp.cleanup()

    @staticmethod
    def successful_run(cmd, check=True, timeout=60):
        stdout = "Reconfigured\n" if cmd[:2] == ["birdc", "configure"] else ""
        return subprocess.CompletedProcess(cmd, 0, stdout=stdout, stderr="")

    def test_migrates_legacy_files_and_state_to_full_asn_names(self):
        with patch.object(agent, "run", self.successful_run), patch.object(agent, "wg_private_key", lambda: "private="):
            agent.apply_peer(dict(self.spec))
        self.assertFalse(self.legacy_wg.exists())
        self.assertFalse(self.legacy_bird.exists())
        self.assertTrue(self.full_wg.exists())
        self.assertTrue(self.full_bird.exists())
        state = json.loads(self.state_file.read_text())[str(self.asn)]
        self.assertEqual(state["iface"], "dn42-4242421234")
        self.assertEqual(state["bgp_proto"], "dn42_4242421234")

    def test_restores_legacy_files_and_state_when_bird_rejects_migration(self):
        original_wg = self.legacy_wg.read_text()
        original_bird = self.legacy_bird.read_text()

        def rejected_run(cmd, check=True, timeout=60):
            stdout = "Reconfiguration failed\n" if cmd[:2] == ["birdc", "configure"] else ""
            return subprocess.CompletedProcess(cmd, 0, stdout=stdout, stderr="")

        with patch.object(agent, "run", rejected_run), patch.object(agent, "wg_private_key", lambda: "private="):
            with self.assertRaisesRegex(RuntimeError, "bird rejected config"):
                agent.apply_peer(dict(self.spec))
        self.assertEqual(self.legacy_wg.read_text(), original_wg)
        self.assertEqual(self.legacy_bird.read_text(), original_bird)
        self.assertFalse(self.full_wg.exists())
        self.assertFalse(self.full_bird.exists())
        state = json.loads(self.state_file.read_text())[str(self.asn)]
        self.assertEqual(state["iface"], "dn42-1234")
        self.assertEqual(state["bgp_proto"], "dn42_1234")


class NamingTests(unittest.TestCase):
    def test_full_asn_names_do_not_collide(self):
        self.assertEqual(agent.iface_name(4242422921), "dn42-4242422921")
        self.assertEqual(agent.iface_name(4201272921), "dn42-4201272921")
        self.assertNotEqual(agent.iface_name(4242422921), agent.iface_name(4201272921))
        self.assertEqual(len(agent.iface_name(4242422921)), 15)
        self.assertEqual(agent.proto_name(4242422921), "dn42_4242422921")

    def test_validate_spec_preserves_explicit_legacy_names(self):
        spec = agent.validate_spec({
            "asn": 4242421234,
            "iface": "dn42-1234",
            "wg_port": 21234,
            "peer_pubkey": "A" * 43 + "=",
            "peer_ll": "fe80::1234",
            "our_ll": "fe80::1",
        })
        self.assertEqual(spec["iface"], "dn42-1234")
        self.assertEqual(spec["bgp_proto"], "dn42_1234")

    def test_validate_spec_defaults_new_sessions_to_full_names(self):
        spec = agent.validate_spec({
            "asn": 4201272921,
            "wg_port": 22921,
            "peer_pubkey": "A" * 43 + "=",
            "peer_ll": "fe80::2921",
            "our_ll": "fe80::1",
        })
        self.assertEqual(spec["iface"], "dn42-4201272921")
        self.assertEqual(spec["bgp_proto"], "dn42_4201272921")


if __name__ == "__main__":
    unittest.main()
