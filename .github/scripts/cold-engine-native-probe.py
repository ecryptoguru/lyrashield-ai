"""Fixed installed-engine probe; stdin supplies the exact Git package fingerprint.

Uses real loopback TCP and fresh Linux interpreters, never MockTransport or live keys.
The lost-ACK/SIGKILL scenario is the engine's test_finite_budget_durability.py case.
"""
import asyncio
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

assert sys.platform == "linux", "native probe requires Linux"
assert not any(os.environ.get(key) for key in (
    "OPENAI_API_KEY", "AZURE_AI_API_KEY", "AZURE_OPENAI_API_KEY",
    "ANTHROPIC_API_KEY", "LITELLM_API_KEY",
)), "probe must receive no provider credentials"
site = Path(importlib.metadata.distribution("lyrashield-engine").locate_file(""))
for relative, digest in expected["engineFiles"].items():
    path = site / relative
    assert path.is_file() and not path.is_symlink(), relative
    assert hashlib.sha256(path.read_bytes()).hexdigest() == digest, relative
for package, version in expected["versions"].items():
    assert importlib.metadata.version(package) == version, package

from agents import Agent, RunConfig, Runner
from agents.extensions.models.litellm_model import LitellmModel
from agents.models.openai_chatcompletions import OpenAIChatCompletionsModel
from agents.models.openai_responses import OpenAIResponsesModel
import litellm
from openai import APIStatusError, AsyncOpenAI
from lyrashield.artifacts import state as state_module
from lyrashield.artifacts.state import ReportState
from lyrashield.lifecycle import hooks as hooks_module
from lyrashield.lifecycle.hooks import BudgetExceededError, ReportUsageHooks
from lyrashield.lifecycle.inputs import make_model_settings
from lyrashield.policy.models import _RequestBoundTurnGuardModel
from lyrashield.policy.physical_requests import guard_physical_model


class Provider(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, mode):
        self.posts = []
        self.accepted = threading.Event()
        self.finish = threading.Event()
        self.mode = mode
        super().__init__(("127.0.0.1", 0), Handler)

    def __enter__(self):
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.finish.set()
        self.shutdown()
        self.server_close()
        self.thread.join(5)
        assert not self.thread.is_alive()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server_port}/v1"


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        size = int(self.headers["content-length"])
        assert 0 < size < 10000
        body = json.loads(self.rfile.read(size))
        assert self.headers.get("Authorization") == "Bearer cold-fixture"
        cap = body.get("max_output_tokens", body.get("max_completion_tokens", body.get("max_tokens")))
        assert body["model"] == "gpt-6-luna" and cap == 128
        self.server.posts.append({"path": self.path, "outputCap": cap})
        self.server.accepted.set()
        if self.server.mode == "503":
            response = b'{"error":{"message":"controlled unavailable"}}'
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.send_header("retry-after-ms", "1")
            self.end_headers()
            self.wfile.write(response)
        elif self.server.mode == "hold":
            self.server.finish.wait(20)
        self.close_connection = True

    def log_message(self, *_args):
        pass


async def unavailable(route, streaming):
    state_module._global_report_state = None
    hooks_module._active_hooks = None
    with tempfile.TemporaryDirectory() as root, Provider("503") as provider:
        state = ReportState("cold-native")
        state._run_dir = Path(root).resolve()
        hooks = ReportUsageHooks(model="openai/gpt-6-luna", max_budget_usd=1,
                                 max_output_tokens=128, report_state=state)
        hooks_module.set_active_hooks(hooks)
        async with AsyncOpenAI(api_key="cold-fixture", base_url=provider.url, timeout=5) as client:
            if route == "litellm":
                model = LitellmModel("openai/gpt-6-luna", api_key="cold-fixture", base_url=provider.url)
                error = litellm.ServiceUnavailableError
            else:
                model = (OpenAIResponsesModel if route == "responses" else OpenAIChatCompletionsModel)(
                    "gpt-6-luna", openai_client=client)
                error = APIStatusError
            settings = make_model_settings(None, model_name="openai/gpt-6-luna",
                                           bounded_budget=True, max_output_tokens=128)
            if route == "litellm":
                # The finite adapter requires an explicitly resolved native client.
                model = guard_physical_model(model, resolved_client=client)
            agent = Agent(name="Root", model=_RequestBoundTurnGuardModel(model), model_settings=settings)
            try:
                if streaming:
                    result = Runner.run_streamed(agent, "offline", context={"agent_id": "root"},
                                                 hooks=hooks, run_config=RunConfig(tracing_disabled=True))
                    async for _ in result.stream_events():
                        pass
                else:
                    await Runner.run(agent, "offline", context={"agent_id": "root"}, hooks=hooks,
                                     run_config=RunConfig(tracing_disabled=True))
            except error:
                pass
            else:
                raise AssertionError("expected controlled 503")
        assert len(provider.posts) == 1, (route, streaming, provider.posts)
        held = sum(hooks._agent_reservations.values())
        assert 0 < held <= 1
        assert hooks.budget_control_state()["pending_provider_charges"]
        return {"name": f"{route}-{'stream' if streaming else 'plain'}-503-cap-no-retry",
                "exitCode": 0, "physicalRequests": 1, "outputCap": 128,
                "retainedPendingCharge": True}


async def exhausted_budget():
    state_module._global_report_state = None
    hooks_module._active_hooks = None
    cap_usd = 0.002
    with tempfile.TemporaryDirectory() as root, Provider("503") as provider:
        state = ReportState("cold-cap")
        state._run_dir = Path(root).resolve()
        hooks = ReportUsageHooks(model="openai/gpt-6-luna", max_budget_usd=cap_usd,
                                 max_output_tokens=128, report_state=state)
        hooks_module.set_active_hooks(hooks)
        async with AsyncOpenAI(api_key="cold-fixture", base_url=provider.url, timeout=5) as client:
            for index in range(20):
                before = len(provider.posts)
                agent = Agent(name="Root", model=_RequestBoundTurnGuardModel(
                    OpenAIResponsesModel("gpt-6-luna", openai_client=client)),
                    model_settings=make_model_settings(None, model_name="openai/gpt-6-luna",
                                                       bounded_budget=True, max_output_tokens=128))
                try:
                    await Runner.run(agent, "offline", context={"agent_id": f"request-{index}"},
                                     hooks=hooks, run_config=RunConfig(tracing_disabled=True))
                except APIStatusError:
                    assert len(provider.posts) == before + 1
                except BudgetExceededError:
                    assert before > 0 and len(provider.posts) == before
                    held = sum(hooks._agent_reservations.values()) + sum(hooks._agent_abandoned_floors.values())
                    assert 0 < held <= cap_usd
                    return {"name": "engine-budget-denies-before-tcp-dispatch", "exitCode": 0,
                            "physicalRequests": before, "deniedRequests": 1,
                            "configuredCapUsd": cap_usd, "heldReservationsUsd": held}
                else:
                    raise AssertionError("controlled 503 unexpectedly succeeded")
            raise AssertionError("finite budget did not stop requests")


CHILD = r'''
import asyncio, sys
from pathlib import Path
from agents import Agent, Runner, RunConfig
from openai import AsyncOpenAI
from agents.models.openai_responses import OpenAIResponsesModel
from lyrashield.artifacts.state import ReportState, set_global_report_state
from lyrashield.lifecycle.hooks import ReportUsageHooks, set_active_hooks
from lyrashield.lifecycle.inputs import make_model_settings
from lyrashield.policy.models import _RequestBoundTurnGuardModel
state=ReportState('cold-wire'); state._run_dir=Path(sys.argv[1])
state.hydrate_from_run_dir(); set_global_report_state(state)
hooks=ReportUsageHooks(model='openai/gpt-6-luna',max_budget_usd=1,max_output_tokens=128)
set_active_hooks(hooks)
async def run():
    async with AsyncOpenAI(api_key='cold-fixture',base_url=sys.argv[2],timeout=3) as client:
        agent=Agent(name='Root',model=_RequestBoundTurnGuardModel(OpenAIResponsesModel('gpt-6-luna',client)),
            model_settings=make_model_settings(None,model_name='openai/gpt-6-luna',bounded_budget=True,max_output_tokens=128))
        try:
            await Runner.run(agent,'offline',context={'agent_id':'root'},hooks=hooks,
                run_config=RunConfig(tracing_disabled=True))
        except Exception:
            pass
print('READY',flush=True)
asyncio.run(run())
'''


def interrupted_request(killed):
    with tempfile.TemporaryDirectory() as root, Provider("hold" if killed else "lost-ack") as provider:
        command = [sys.executable, "-I", "-c", CHILD, str(Path(root).resolve()), provider.url]
        child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        bootstrap = queue.Queue()
        reader = threading.Thread(target=lambda: bootstrap.put(child.stdout.readline()), daemon=True)
        reader.start()
        try:
            assert bootstrap.get(timeout=30).strip() == b"READY"
            assert provider.accepted.wait(10)
            raw = json.loads((Path(root) / "run.json").read_text())
            pending = raw["_finite_budget_guard"]["pending"]
            assert len(pending) == 1 and raw["llm_usage"].get("cost", 0) == 0
            if killed:
                child.kill()
            child.communicate(timeout=10)
            retry = subprocess.run(command, capture_output=True, timeout=30, check=False)
            assert retry.returncode != 0 and b"pending provider charge" in retry.stderr
            assert len(provider.posts) == 1
            assert json.loads((Path(root) / "run.json").read_text())["_finite_budget_guard"]["pending"] == pending
            return {"name": "engine-sigkill-no-paid-resume" if killed else "engine-lost-ack-no-paid-resume",
                    "exitCode": 0, "physicalRequests": 1, "retryExitCode": retry.returncode,
                    "retainedPendingCharge": True}
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate(timeout=10)
            reader.join(5)


async def main():
    cases = []
    for route in ("responses", "chat", "litellm"):
        for streaming in (False, True):
            cases.append(await unavailable(route, streaming))
    cases.append(await exhausted_budget())
    # Clear the in-process journal owner before starting fresh interpreter cases.
    hooks_module._active_hooks = None
    state_module._global_report_state = None
    for killed in (False, True):
        cases.append(interrupted_request(killed))
    print("COLD_NATIVE_RESULT=" + json.dumps({"cases": cases}, sort_keys=True))


asyncio.run(main())
