"""Tests for the conductor.* cockpit JSON-RPC methods on the TUI gateway.

These exercise the THIN PROXY (ADR-2) handlers that subprocess-invoke the PH
Node cockpit runner. No real node / subprocess is spawned: a fake runner is
injected via the module-level ``server._cockpit_tool_runner`` hook (mirrors the
``monkeypatch.setattr(server, ...)`` style used in test_tui_gateway_server.py).
"""

import json

import pytest

from tui_gateway import server


# ── Fakes ────────────────────────────────────────────────────────────


def _make_recording_runner(result):
    """Return (runner, calls) where runner records every argv it was given."""
    calls: list[list[str]] = []

    def _runner(argv, timeout):  # noqa: ANN001 - mirrors subprocess.run shape
        calls.append(list(argv))
        return result

    return _runner, calls


class _FakeCompleted:
    def __init__(self, stdout="", returncode=0):
        self.stdout = stdout
        self.returncode = returncode


# ── Registration ─────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "name",
    ["conductor.missions.list", "conductor.cockpit.get", "conductor.receipts.tail"],
)
def test_conductor_methods_are_registered(name):
    assert name in server._methods
    assert callable(server._methods[name])


# ── conductor.missions.list ──────────────────────────────────────────


def test_missions_list_returns_runner_json(monkeypatch):
    runner, calls = _make_recording_runner({"ok": True, "missions": [{"id": "m1"}]})
    monkeypatch.setattr(server, "_cockpit_tool_runner", runner)

    resp = server._methods["conductor.missions.list"]("r1", {"limit": 7})

    assert resp["result"] == {"ok": True, "missions": [{"id": "m1"}]}
    assert "error" not in resp
    # argv is a LIST: [node, runner_path, tool_name, json_args]
    argv = calls[0]
    assert isinstance(argv, list)
    assert argv[-2] == "cockpit_missions_list"
    assert json.loads(argv[-1]) == {"limit": 7}


def test_missions_list_defaults_limit(monkeypatch):
    runner, calls = _make_recording_runner({"ok": True, "missions": []})
    monkeypatch.setattr(server, "_cockpit_tool_runner", runner)

    resp = server._methods["conductor.missions.list"]("r1", {})

    assert resp["result"]["ok"] is True
    assert json.loads(calls[0][-1]) == {"limit": 50}


# ── conductor.cockpit.get ────────────────────────────────────────────


def test_cockpit_get_requires_mission_id(monkeypatch):
    runner, calls = _make_recording_runner({"ok": True})
    monkeypatch.setattr(server, "_cockpit_tool_runner", runner)

    resp = server._methods["conductor.cockpit.get"]("r1", {})

    assert resp["error"]["code"] == 4002
    assert resp["error"]["message"] == "missionId required"
    # runner must NOT have been invoked
    assert calls == []


def test_cockpit_get_rejects_blank_mission_id(monkeypatch):
    runner, calls = _make_recording_runner({"ok": True})
    monkeypatch.setattr(server, "_cockpit_tool_runner", runner)

    resp = server._methods["conductor.cockpit.get"]("r1", {"missionId": "   "})

    assert resp["error"]["code"] == 4002
    assert calls == []


def test_cockpit_get_rejects_non_string_mission_id(monkeypatch):
    runner, calls = _make_recording_runner({"ok": True})
    monkeypatch.setattr(server, "_cockpit_tool_runner", runner)

    resp = server._methods["conductor.cockpit.get"]("r1", {"missionId": 123})

    assert resp["error"]["code"] == 4002
    assert calls == []


def test_cockpit_get_returns_runner_json(monkeypatch):
    runner, calls = _make_recording_runner({"ok": True, "projection": {"id": "m9"}})
    monkeypatch.setattr(server, "_cockpit_tool_runner", runner)

    resp = server._methods["conductor.cockpit.get"]("r1", {"missionId": "m9"})

    assert resp["result"] == {"ok": True, "projection": {"id": "m9"}}
    argv = calls[0]
    assert argv[-2] == "cockpit_projection_get"
    assert json.loads(argv[-1]) == {"missionId": "m9"}


# ── conductor.receipts.tail ──────────────────────────────────────────


def test_receipts_tail_returns_runner_json(monkeypatch):
    runner, calls = _make_recording_runner({"ok": True, "receipts": []})
    monkeypatch.setattr(server, "_cockpit_tool_runner", runner)

    resp = server._methods["conductor.receipts.tail"](
        "r1", {"afterSequence": 42, "limit": 5}
    )

    assert resp["result"] == {"ok": True, "receipts": []}
    argv = calls[0]
    assert argv[-2] == "cockpit_receipts_tail"
    assert json.loads(argv[-1]) == {"afterSequence": 42, "limit": 5}


def test_receipts_tail_defaults(monkeypatch):
    runner, calls = _make_recording_runner({"ok": True, "receipts": []})
    monkeypatch.setattr(server, "_cockpit_tool_runner", runner)

    resp = server._methods["conductor.receipts.tail"]("r1", {})

    assert resp["result"]["ok"] is True
    assert json.loads(calls[0][-1]) == {"afterSequence": 0, "limit": 100}


# ── ok:false surfaces as _ok envelope (RPC succeeded, tool said no) ───


def test_runner_ok_false_still_surfaces_as_ok_envelope(monkeypatch):
    runner, _ = _make_recording_runner({"ok": False, "reason": "no_missions"})
    monkeypatch.setattr(server, "_cockpit_tool_runner", runner)

    resp = server._methods["conductor.missions.list"]("r1", {})

    # The RPC itself succeeded -> _ok envelope; the tool's negative result rides inside.
    assert "result" in resp
    assert "error" not in resp
    assert resp["result"] == {"ok": False, "reason": "no_missions"}


# ── timeout / exception -> cockpit_runner_* reason, never raises ──────


def test_runner_timeout_maps_to_reason(monkeypatch):
    import subprocess

    def _boom(argv, timeout):  # noqa: ANN001
        raise subprocess.TimeoutExpired(cmd=argv, timeout=timeout)

    monkeypatch.setattr(server, "_cockpit_tool_runner", _boom)

    resp = server._methods["conductor.missions.list"]("r1", {})

    assert "result" in resp  # never raises, never an RPC error
    assert resp["result"]["ok"] is False
    assert resp["result"]["reason"] == "cockpit_runner_timeout"


def test_runner_file_not_found_maps_to_reason(monkeypatch):
    def _boom(argv, timeout):  # noqa: ANN001
        raise FileNotFoundError("no node here")

    monkeypatch.setattr(server, "_cockpit_tool_runner", _boom)

    resp = server._methods["conductor.receipts.tail"]("r1", {})

    assert resp["result"]["ok"] is False
    assert resp["result"]["reason"] == "cockpit_runner_not_found"


def test_runner_unexpected_exception_maps_to_reason(monkeypatch):
    def _boom(argv, timeout):  # noqa: ANN001
        raise RuntimeError("kaboom /secret/path/creds")

    monkeypatch.setattr(server, "_cockpit_tool_runner", _boom)

    resp = server._methods["conductor.missions.list"]("r1", {})

    assert resp["result"]["ok"] is False
    assert resp["result"]["reason"] == "cockpit_runner_error"
    # Reason must NOT leak the exception text (could carry paths/creds).
    assert "secret" not in json.dumps(resp["result"])
    assert "kaboom" not in json.dumps(resp["result"])


# ── helper: parsing semantics over the (default) subprocess runner ────


def test_helper_parses_last_nonempty_stdout_line(monkeypatch):
    # Fake the DEFAULT runner path: substitute subprocess.run via the real
    # _default_cockpit_runner, proving last-line JSON parsing + argv shape.
    recorded = {}

    def _fake_run(argv, capture_output, text, timeout):  # noqa: ANN001
        recorded["argv"] = argv
        recorded["timeout"] = timeout
        recorded["shell_kw"] = False
        return _FakeCompleted(
            stdout="warming up\n\n" + json.dumps({"ok": True, "n": 3}) + "\n",
            returncode=0,
        )

    monkeypatch.setattr(server.subprocess, "run", _fake_run)

    result = server._default_cockpit_runner(
        [server._resolve_node(), "/x/runner.mjs", "cockpit_missions_list", "{}"],
        timeout=20,
    )

    assert result == {"ok": True, "n": 3}
    assert isinstance(recorded["argv"], list)
    assert recorded["timeout"] == 20


def test_helper_unparseable_stdout_returns_reason(monkeypatch):
    def _fake_run(argv, capture_output, text, timeout):  # noqa: ANN001
        return _FakeCompleted(stdout="not json at all\n", returncode=1)

    monkeypatch.setattr(server.subprocess, "run", _fake_run)

    result = server._default_cockpit_runner(["node", "r.mjs", "t", "{}"], timeout=20)

    assert result["ok"] is False
    assert result["reason"] == "cockpit_runner_parse"


def test_helper_empty_stdout_returns_reason(monkeypatch):
    def _fake_run(argv, capture_output, text, timeout):  # noqa: ANN001
        return _FakeCompleted(stdout="   \n\n", returncode=1)

    monkeypatch.setattr(server.subprocess, "run", _fake_run)

    result = server._default_cockpit_runner(["node", "r.mjs", "t", "{}"], timeout=20)

    assert result["ok"] is False
    assert result["reason"] == "cockpit_runner_empty"


def test_run_cockpit_tool_builds_argv_list_no_shell(monkeypatch):
    """The helper that handlers call must build an ARGV LIST and pass args as
    json.dumps(args). It must never use shell=True."""
    captured = {}

    def _runner(argv, timeout):  # noqa: ANN001
        captured["argv"] = argv
        captured["timeout"] = timeout
        return {"ok": True}

    monkeypatch.setattr(server, "_cockpit_tool_runner", _runner)

    server._run_cockpit_tool("cockpit_missions_list", {"limit": 9})

    argv = captured["argv"]
    assert isinstance(argv, list)
    # [node, runner_path, tool_name, json_args]
    assert len(argv) == 4
    assert argv[2] == "cockpit_missions_list"
    assert json.loads(argv[3]) == {"limit": 9}
    assert captured["timeout"] == 20


def test_run_cockpit_tool_honors_env_runner_path(monkeypatch):
    captured = {}

    def _runner(argv, timeout):  # noqa: ANN001
        captured["argv"] = argv
        return {"ok": True}

    monkeypatch.setattr(server, "_cockpit_tool_runner", _runner)
    monkeypatch.setenv("HERMES_COCKPIT_TOOL_RUNNER", "/custom/runner.mjs")

    server._run_cockpit_tool("cockpit_receipts_tail", {})

    assert captured["argv"][1] == "/custom/runner.mjs"


# ── conductor.systemcheck (Developer-OS self-check, SAFE) ─────────────


def _make_self_check_runner(result):
    """Return (runner, calls) recording every argv passed to the self-check."""
    calls: list[list[str]] = []

    def _runner(argv, timeout):  # noqa: ANN001
        calls.append(list(argv))
        return result

    return _runner, calls


_READY_MATRIX = {
    "schema": "developer_os_self_check_v1",
    "ready": True,
    "verdict": "READY",
    "capabilities": [
        {"name": "CAP-1", "status": "live", "evidence": "ev1", "detail": "d1"},
        {"name": "CAP-2", "status": "live", "evidence": "ev2", "detail": "d2"},
    ],
    "governanceFloors": [
        {"floor": "FLOOR-1", "holds": True, "evidence": "fe1"},
    ],
    "summary": {"capabilitiesLive": 2},
    "generatedNote": "in-process, dry-run only; no spawn, no execute.",
}


def test_systemcheck_method_is_registered():
    assert "conductor.systemcheck" in server._methods
    assert callable(server._methods["conductor.systemcheck"])


def test_systemcheck_routed_into_long_handlers():
    # It spawns a subprocess, so it must dispatch on the long-handler pool.
    assert "conductor.systemcheck" in server._LONG_HANDLERS


def test_systemcheck_returns_report_via_injected_runner(monkeypatch):
    runner, calls = _make_self_check_runner(_READY_MATRIX)
    monkeypatch.setattr(server, "_self_check_runner", runner)

    resp = server._methods["conductor.systemcheck"]("r1", {})

    assert "error" not in resp
    assert resp["result"] == {"ok": True, "report": _READY_MATRIX}
    # The matrix rides under report verbatim (verdict + rows preserved).
    assert resp["result"]["report"]["verdict"] == "READY"
    assert resp["result"]["report"]["capabilities"][0]["name"] == "CAP-1"


def test_systemcheck_uses_argv_list_with_json_flag_no_shell(monkeypatch):
    runner, calls = _make_self_check_runner(_READY_MATRIX)
    monkeypatch.setattr(server, "_self_check_runner", runner)

    server._methods["conductor.systemcheck"]("r1", {})

    argv = calls[0]
    assert isinstance(argv, list)
    # [node, script, "--json"] — args ride as discrete list elements, never a
    # shell string.
    assert argv[-1] == "--json"
    assert len(argv) == 3


def test_systemcheck_maps_runner_failure_to_self_check_reason(monkeypatch):
    runner, _ = _make_self_check_runner(
        {"ok": False, "reason": "self_check_timeout"}
    )
    monkeypatch.setattr(server, "_self_check_runner", runner)

    resp = server._methods["conductor.systemcheck"]("r1", {})

    # The RPC itself succeeded -> _ok envelope; the failure reason rides inside.
    assert "result" in resp
    assert "error" not in resp
    assert resp["result"] == {"ok": False, "reason": "self_check_timeout"}


def test_systemcheck_not_ready_matrix_still_surfaces_as_report(monkeypatch):
    not_ready = dict(_READY_MATRIX, verdict="NOT-READY", ready=False)
    runner, _ = _make_self_check_runner(not_ready)
    monkeypatch.setattr(server, "_self_check_runner", runner)

    resp = server._methods["conductor.systemcheck"]("r1", {})

    # A NOT-READY verdict is a VALID report, not a failure.
    assert resp["result"]["ok"] is True
    assert resp["result"]["report"]["verdict"] == "NOT-READY"


def test_systemcheck_timeout_maps_to_reason(monkeypatch):
    import subprocess

    def _boom(argv, timeout):  # noqa: ANN001
        raise subprocess.TimeoutExpired(cmd=argv, timeout=timeout)

    monkeypatch.setattr(server, "_self_check_runner", _boom)

    resp = server._methods["conductor.systemcheck"]("r1", {})

    assert resp["result"]["ok"] is False
    assert resp["result"]["reason"] == "self_check_timeout"


def test_systemcheck_unexpected_exception_does_not_leak(monkeypatch):
    def _boom(argv, timeout):  # noqa: ANN001
        raise RuntimeError("kaboom /secret/path/creds")

    monkeypatch.setattr(server, "_self_check_runner", _boom)

    resp = server._methods["conductor.systemcheck"]("r1", {})

    assert resp["result"]["ok"] is False
    assert resp["result"]["reason"] == "self_check_error"
    assert "secret" not in json.dumps(resp["result"])
    assert "kaboom" not in json.dumps(resp["result"])


# ── default self-check runner: multi-line JSON + exit-code semantics ──


def test_self_check_runner_parses_multiline_pretty_json(monkeypatch):
    pretty = json.dumps(_READY_MATRIX, indent=2) + "\n"

    def _fake_run(argv, capture_output, text, timeout):  # noqa: ANN001
        assert isinstance(argv, list)
        return _FakeCompleted(stdout=pretty, returncode=0)

    monkeypatch.setattr(server.subprocess, "run", _fake_run)

    result = server._default_self_check_runner(
        [server._resolve_node(), "/x/self-check.mjs", "--json"], timeout=30
    )

    assert result["verdict"] == "READY"
    assert result["schema"] == "developer_os_self_check_v1"


def test_self_check_runner_keeps_not_ready_report_despite_nonzero_exit(monkeypatch):
    not_ready = dict(_READY_MATRIX, verdict="NOT-READY", ready=False)
    pretty = json.dumps(not_ready, indent=2) + "\n"

    def _fake_run(argv, capture_output, text, timeout):  # noqa: ANN001
        # The real runner exits 1 on NOT-READY, but the report is still valid.
        return _FakeCompleted(stdout=pretty, returncode=1)

    monkeypatch.setattr(server.subprocess, "run", _fake_run)

    result = server._default_self_check_runner(["node", "s.mjs", "--json"], timeout=30)

    assert result["verdict"] == "NOT-READY"
    assert "reason" not in result


def test_self_check_runner_tolerates_leading_warmup_noise(monkeypatch):
    one_line = json.dumps(_READY_MATRIX)

    def _fake_run(argv, capture_output, text, timeout):  # noqa: ANN001
        return _FakeCompleted(stdout="warming up\n\n" + one_line + "\n", returncode=0)

    monkeypatch.setattr(server.subprocess, "run", _fake_run)

    result = server._default_self_check_runner(["node", "s.mjs", "--json"], timeout=30)

    assert result["verdict"] == "READY"


def test_self_check_runner_unparseable_returns_reason(monkeypatch):
    def _fake_run(argv, capture_output, text, timeout):  # noqa: ANN001
        return _FakeCompleted(stdout="not json at all\n", returncode=1)

    monkeypatch.setattr(server.subprocess, "run", _fake_run)

    result = server._default_self_check_runner(["node", "s.mjs", "--json"], timeout=30)

    assert result["ok"] is False
    assert result["reason"] == "self_check_nonzero"


def test_self_check_runner_empty_returns_reason(monkeypatch):
    def _fake_run(argv, capture_output, text, timeout):  # noqa: ANN001
        return _FakeCompleted(stdout="   \n\n", returncode=1)

    monkeypatch.setattr(server.subprocess, "run", _fake_run)

    result = server._default_self_check_runner(["node", "s.mjs", "--json"], timeout=30)

    assert result["ok"] is False
    assert result["reason"] == "self_check_empty"


def test_self_check_runner_timeout_returns_reason(monkeypatch):
    import subprocess

    def _fake_run(argv, capture_output, text, timeout):  # noqa: ANN001
        raise subprocess.TimeoutExpired(cmd=argv, timeout=timeout)

    monkeypatch.setattr(server.subprocess, "run", _fake_run)

    result = server._default_self_check_runner(["node", "s.mjs", "--json"], timeout=30)

    assert result["ok"] is False
    assert result["reason"] == "self_check_timeout"


def test_self_check_runner_not_found_returns_reason(monkeypatch):
    def _fake_run(argv, capture_output, text, timeout):  # noqa: ANN001
        raise FileNotFoundError("no node here")

    monkeypatch.setattr(server.subprocess, "run", _fake_run)

    result = server._default_self_check_runner(["node", "s.mjs", "--json"], timeout=30)

    assert result["ok"] is False
    assert result["reason"] == "self_check_not_found"


def test_run_self_check_builds_argv_list_with_json(monkeypatch):
    captured = {}

    def _runner(argv, timeout):  # noqa: ANN001
        captured["argv"] = argv
        captured["timeout"] = timeout
        return _READY_MATRIX

    monkeypatch.setattr(server, "_self_check_runner", _runner)

    server._run_self_check()

    argv = captured["argv"]
    assert isinstance(argv, list)
    assert len(argv) == 3
    assert argv[2] == "--json"
    assert captured["timeout"] == 30


def test_run_self_check_honors_env_runner_path(monkeypatch):
    captured = {}

    def _runner(argv, timeout):  # noqa: ANN001
        captured["argv"] = argv
        return _READY_MATRIX

    monkeypatch.setattr(server, "_self_check_runner", _runner)
    monkeypatch.setenv("HERMES_SELF_CHECK_RUNNER", "/custom/self-check.mjs")

    server._run_self_check()

    assert captured["argv"][1] == "/custom/self-check.mjs"
