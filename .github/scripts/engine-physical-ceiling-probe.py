"""Offline probe sent to the immutable worker image on stdin, never imported by production."""
import asyncio
from contextlib import redirect_stdout
import hashlib
import importlib.metadata
import io
import json
import os
from pathlib import Path
import tempfile
from uuid import uuid4

# `expected` comes from the fixed host runner, derived from exact M's lock and wheel.
for package, version in expected['versions'].items():
    assert importlib.metadata.version(package) == version, package
site = Path(importlib.metadata.distribution('lyrashield-engine').locate_file('')).resolve()
roots = ('lyrashield', 'lyrashield_adapter', 'strix')
actual = {}
for root in roots:
    directory = site / root
    assert directory.is_dir() and not directory.is_symlink(), root
    for path in directory.rglob('*'):
        assert not path.is_symlink(), str(path)
        if path.is_file() and '__pycache__' not in path.parts and path.suffix not in ('.pyc', '.pyo'):
            relative = path.relative_to(site).as_posix()
            actual[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
assert actual == expected['wheelFiles'], 'installed engine differs from exact engine wheel'

import httpx
import litellm
from agents import Agent, RunConfig, Runner
from agents.extensions.models.litellm_model import LitellmModel
from agents.models._retry_runtime import should_disable_provider_managed_retries
from agents.models.openai_chatcompletions import OpenAIChatCompletionsModel
from agents.models.openai_responses import OpenAIResponsesModel
from litellm.llms.openai.openai import OpenAIChatCompletion
from openai import APIStatusError, AsyncOpenAI

from lyrashield.artifacts import state as state_module
from lyrashield.artifacts.state import ReportState
from lyrashield.lifecycle import hooks as hooks_module
from lyrashield.lifecycle.hooks import ReportUsageHooks
from lyrashield.lifecycle.inputs import make_model_settings

async def exercise(api, streaming):
    state_module._global_report_state = None
    hooks_module._active_hooks = None
    attempts = []
    def unavailable(request):
        body = json.loads(request.content)
        attempts.append({'path': request.url.path, 'body': body})
        return httpx.Response(503, headers={'retry-after-ms':'1'}, json={'error':{'message':'offline'}})
    with tempfile.TemporaryDirectory(prefix='physical-ceiling-') as root:
        state = ReportState('offline-' + uuid4().hex)
        state._run_dir = Path(root).resolve() / state.run_name
        hooks = ReportUsageHooks(model='openai/gpt-6-luna', max_budget_usd=1,
                                 max_output_tokens=128, report_state=state)
        hooks_module.set_active_hooks(hooks)
        async with AsyncOpenAI(api_key='offline-test',
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(unavailable))) as client:
            native_retries = []
            old_factory = OpenAIChatCompletion._get_openai_client
            if api == 'litellm':
                def factory(_self, **kwargs):
                    native_retries.append(kwargs['max_retries'])
                    return client.with_options(max_retries=kwargs['max_retries'])
                OpenAIChatCompletion._get_openai_client = factory
                model = LitellmModel('openai/gpt-6-luna', api_key='offline-test')
                error = litellm.ServiceUnavailableError
            else:
                model = (OpenAIResponsesModel if api == 'responses' else OpenAIChatCompletionsModel)(
                    'gpt-6-luna', openai_client=client)
                error = APIStatusError
            try:
                settings = make_model_settings(None, model_name='openai/gpt-6-luna',
                                               bounded_budget=True, max_output_tokens=128)
                agent = Agent(name='Root', model=model, model_settings=settings)
                try:
                    if streaming:
                        result = Runner.run_streamed(agent, 'offline', context={'agent_id':'root'},
                            hooks=hooks, run_config=RunConfig(tracing_disabled=True))
                        async for _event in result.stream_events():
                            pass
                    else:
                        await Runner.run(agent, 'offline', context={'agent_id':'root'},
                                         hooks=hooks, run_config=RunConfig(tracing_disabled=True))
                except error:
                    pass
                else:
                    raise AssertionError('synthetic 503 did not propagate')
            finally:
                OpenAIChatCompletion._get_openai_client = old_factory
        assert len(attempts) == 1, (api, streaming, len(attempts))
        if api == 'litellm':
            assert native_retries == [0]
        body = attempts[0]['body']
        cap = body.get('max_output_tokens', body.get('max_completion_tokens', body.get('max_tokens')))
        assert cap == 128, (api, cap)
        reserved = sum(hooks._agent_reservations.values())
        assert 0 < reserved <= 1, reserved
        assert not should_disable_provider_managed_retries()
        return {'route': api, 'streaming': streaming, 'attempts': 1, 'outputCap': cap}

async def main():
    cases = []
    # Some provider libraries print diagnostic banners even on an expected 503.
    # Keep stdout reserved for the single structured result.
    with redirect_stdout(io.StringIO()):
        for api in ('responses', 'chat', 'litellm'):
            for streaming in (False, True):
                cases.append(await exercise(api, streaming))
    print(json.dumps({'cases': cases, 'versions': expected['versions'],
                      'wheelFingerprint': expected['wheelFingerprint']}, sort_keys=True))
asyncio.run(main())
