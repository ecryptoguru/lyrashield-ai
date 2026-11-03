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
from openai import APIConnectionError, APIStatusError, AsyncOpenAI

from lyrashield.artifacts import state as state_module
from lyrashield.artifacts.state import ReportState
from lyrashield.lifecycle import hooks as hooks_module
from lyrashield.lifecycle.hooks import (
    BudgetExceededError,
    ReportUsageHooks,
    _model_rate_card,
    _reservation_input_rate,
)
from lyrashield.lifecycle.inputs import make_model_settings

async def exercise(api, streaming):
    state_module._global_report_state = None
    hooks_module._active_hooks = None
    attempts = []
    def unavailable(request):
        body = json.loads(request.content)
        assert body.get('model') == 'gpt-6-luna' and body.get('n', 1) == 1
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

async def exercise_aggregate():
    """Two simultaneous submissions, a fallback with lost ACK, and denied admission."""
    state_module._global_report_state = None
    hooks_module._active_hooks = None
    model_name = 'openai/gpt-6-luna'
    # This tighter cap admits the first three bounded requests at the frozen
    # price card and must reject the next one using the same shared ledger.
    cap_usd = 0.002
    wire = []
    both_reached = asyncio.Event()

    async def endpoint(request):
        body = json.loads(request.content)
        assert body.get('model') == 'gpt-6-luna' and body.get('n', 1) == 1
        assert len(request.content) < 10_000  # This fixture does not use long-context pricing.
        output = body.get('max_output_tokens', body.get('max_completion_tokens', body.get('max_tokens')))
        assert output == 128
        wire.append({'path': request.url.path, 'bytes': len(request.content), 'outputCap': output})
        if len(wire) <= 2:
            if len(wire) == 2:
                both_reached.set()
            await asyncio.wait_for(both_reached.wait(), timeout=5)
            return httpx.Response(503, json={'error': {'message': 'offline'}})
        raise httpx.ReadError('synthetic response lost after acceptance', request=request)

    def settings():
        return make_model_settings(None, model_name=model_name, bounded_budget=True,
                                   max_output_tokens=128)

    async def run(agent, hooks, agent_id):
        return await Runner.run(agent, 'offline', context={'agent_id': agent_id}, hooks=hooks,
                                run_config=RunConfig(tracing_disabled=True))

    with tempfile.TemporaryDirectory(prefix='physical-aggregate-') as root:
        state = ReportState('offline-' + uuid4().hex)
        state._run_dir = Path(root).resolve() / state.run_name
        hooks = ReportUsageHooks(model=model_name, max_budget_usd=cap_usd,
                                 max_output_tokens=128, report_state=state)
        hooks_module.set_active_hooks(hooks)
        async with AsyncOpenAI(api_key='offline-test',
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(endpoint))) as client:
            native = OpenAIResponsesModel('gpt-6-luna', openai_client=client)
            agents = [Agent(name='Concurrent '+str(i), model=native, model_settings=settings())
                      for i in range(2)]
            outcomes = await asyncio.gather(*(run(agent, hooks, 'agent-'+str(i))
                                              for i, agent in enumerate(agents)),
                                            return_exceptions=True)
            assert len(wire) == 2 and all(isinstance(x, APIStatusError) for x in outcomes)
            fallback = Agent(name='Fallback',
                             model=OpenAIChatCompletionsModel('gpt-6-luna', openai_client=client),
                             model_settings=settings())
            try:
                await run(fallback, hooks, 'fallback')
            except APIConnectionError:
                pass
            else:
                raise AssertionError('lost acknowledgement was not surfaced')
            assert len(wire) == 3 and wire[0]['path'].endswith('/responses')
            assert wire[1]['path'].endswith('/responses') and wire[2]['path'].endswith('/chat/completions')
            active = sum(hooks._agent_reservations.values())
            abandoned = sum(hooks._agent_abandoned_floors.values())
            assert 0 < active + abandoned <= cap_usd

            # With those three uncertain costs still held, the same ledger must
            # reject the next request before the transport sees it.
            try:
                await run(Agent(name='Denied', model=native, model_settings=settings()),
                          hooks, 'denied')
            except BudgetExceededError:
                pass
            else:
                raise AssertionError('request exceeding remaining cap was admitted')
            assert len(wire) == 3
            assert sum(hooks._agent_reservations.values()) == active
            assert sum(hooks._agent_abandoned_floors.values()) == abandoned

        # Model a deliberately pessimistic maximum per synthetic wire request using
        # byte count plus framing for input and its admitted output limit. This is an
        # offline estimate at the engine's price card, not provider billing evidence.
        input_rate = _reservation_input_rate(model_name)
        output_rate = _model_rate_card(model_name)[3]
        assert 0 < input_rate and 0 < output_rate
        modeled = sum(((r['bytes'] + 1024) * input_rate + r['outputCap'] * output_rate)
                      / 1_000_000 for r in wire)
        assert 0 < modeled <= cap_usd
        assert modeled <= active + abandoned
        assert not should_disable_provider_managed_retries()
        return {'concurrentAttempts': 2, 'fallbackAttempts': 1, 'deniedAttempts': 0,
                'configuredCapUsd': cap_usd, 'modeledMaximumUsd': modeled,
                'heldReservationsUsd': active + abandoned, 'priceModel': model_name,
                'inputRatePerMillion': input_rate, 'outputRatePerMillion': output_rate}

async def main():
    cases = []
    # Some provider libraries print diagnostic banners even on an expected 503.
    # Keep stdout reserved for the single structured result.
    with redirect_stdout(io.StringIO()):
        for api in ('responses', 'chat', 'litellm'):
            for streaming in (False, True):
                cases.append(await exercise(api, streaming))
        aggregate = await exercise_aggregate()
    print(json.dumps({'cases': cases, 'versions': expected['versions'],
                      'wheelFingerprint': expected['wheelFingerprint'],
                      'aggregate': aggregate}, sort_keys=True))
asyncio.run(main())
