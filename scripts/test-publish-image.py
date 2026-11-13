#!/usr/bin/env python3
"""Exercise credential restoration without touching a real registry."""
import importlib.util
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("publisher", pathlib.Path(__file__).with_name("publish-image.py"))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class CredentialRestoration(unittest.TestCase):
    def test_restores_previous_identity_after_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            config = pathlib.Path(directory) / "config.json"
            original = b'{"auths":{"example.test":{"auth":"fixture"}}}\n'
            config.write_bytes(original)
            config.chmod(0o640)
            def login(*args, **kwargs):
                config.write_text('{"auths":{"ghcr.io":{"auth":"short-job-token"}}}')
            with patch.dict(os.environ, {"DOCKER_CONFIG": directory}), patch.object(publisher, "run", side_effect=login):
                with self.assertRaisesRegex(RuntimeError, "build failed"):
                    with publisher.registry_login("fixture-token", "fixture-owner"):
                        raise RuntimeError("build failed")
            self.assertEqual(config.read_bytes(), original)
            self.assertEqual(config.stat().st_mode & 0o777, 0o640)

    def test_removes_new_identity_after_success(self):
        with tempfile.TemporaryDirectory() as directory:
            config = pathlib.Path(directory) / "config.json"
            with patch.dict(os.environ, {"DOCKER_CONFIG": directory}), patch.object(publisher, "run", side_effect=lambda *a, **k: config.write_text('{}')):
                with publisher.registry_login("fixture-token", "fixture-owner"):
                    self.assertTrue(config.exists())
            self.assertFalse(config.exists())

    def test_refuses_external_credential_store(self):
        with tempfile.TemporaryDirectory() as directory:
            config = pathlib.Path(directory) / "config.json"
            config.write_text(json.dumps({"credsStore": "desktop"}))
            with patch.dict(os.environ, {"DOCKER_CONFIG": directory}), patch.object(publisher, "run") as run:
                with self.assertRaisesRegex(RuntimeError, "credential helpers"):
                    with publisher.registry_login("fixture-token", "fixture-owner"):
                        pass
                run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
