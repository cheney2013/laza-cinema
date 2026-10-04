"""Tests of the canvas MCP server need the `mcp` package, which the backend's own venv cannot hold
(it pins an older pydantic than mcp needs; the server runs on AI_CINEMA_MCP_PYTHON). Under the
backend venv those tests are skipped; run them with the MCP Python to exercise them."""
import importlib
import unittest


def import_mcp_server():
    try:
        return importlib.import_module("canvas_mcp_server")
    except ModuleNotFoundError as exc:
        if exc.name and exc.name.split(".")[0] == "mcp":
            raise unittest.SkipTest("needs the mcp package: run with AI_CINEMA_MCP_PYTHON") from exc
        raise
