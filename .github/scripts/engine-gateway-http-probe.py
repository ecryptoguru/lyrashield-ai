import asyncio
import os
from pathlib import Path
from tempfile import TemporaryDirectory

from agents import (
    Agent,
    ApplyPatchTool,
    CustomTool,
    RunConfig,
    Runner,
    ShellTool,
    function_tool,
)
from lyrashield.artifacts.dedupe import DedupeJudgement
from lyrashield.artifacts.state import ReportState, set_global_report_state
from lyrashield.lifecycle.hooks import ReportUsageHooks
from lyrashield.lifecycle.inputs import make_model_settings
from lyrashield.policy.models import StrixProvider
from lyrashield.policy.settings import LlmSettings, Settings
from tests.finite_budget_fixtures import owned_hooks
from tests.test_physical_budget_boundaries import _run


@function_tool(strict_mode=False)
def echo(value: str) -> str:
    """Return a synthetic value."""
    return value


async def echo_custom(_context, value: str) -> str:
    return value


async def echo_shell(_request) -> str:
    return "synthetic"


class SyntheticEditor:
    def create_file(self, _operation):
        return "synthetic"

    def update_file(self, _operation):
        return "synthetic"

    def delete_file(self, _operation):
        return "synthetic"


async def main():
    settings = Settings(
        llm=LlmSettings(
            model="azure_ai/gpt-6-luna",
            api_key=os.environ["PROBE_GRANT"],
            api_base=os.environ["LYRASHIELD_PROVIDER_GATEWAY_ORIGIN"]
            + "/v1/provider/azure-ai",
        )
    )
    model = StrixProvider(settings=settings).get_model("azure_ai/gpt-6-luna")
    with TemporaryDirectory() as directory:
        state = ReportState(os.environ["PROBE_SCAN_ID"])
        state._run_dir = Path(directory) / state.run_id
        set_global_report_state(state)
        hooks = owned_hooks(ReportUsageHooks, Path(directory))(
            model="openai/gpt-6-luna", max_budget_usd=1
        )
        if os.environ["PROBE_STRUCTURED"] == "1":
            agent = Agent(
                name="Root",
                model=model,
                model_settings=make_model_settings(
                    None,
                    model_name="openai/gpt-6-luna",
                    bounded_budget=True,
                    max_output_tokens=128,
                ),
                output_type=DedupeJudgement,
            )
            response = await Runner.run(
                agent,
                "offline",
                context={"agent_id": "root"},
                hooks=hooks,
                run_config=RunConfig(tracing_disabled=True),
            )
            assert response.final_output.is_duplicate is False
            return
        if any(
            os.environ[name] == "1"
            for name in ("PROBE_TOOL", "PROBE_CUSTOM", "PROBE_SHELL", "PROBE_PATCH")
        ):
            tool = echo
            if os.environ["PROBE_CUSTOM"] == "1":
                tool = CustomTool(
                    name="echo",
                    description="Return a synthetic value.",
                    on_invoke_tool=echo_custom,
                )
            if os.environ["PROBE_SHELL"] == "1":
                tool = ShellTool(executor=echo_shell)
            if os.environ["PROBE_PATCH"] == "1":
                tool = ApplyPatchTool(editor=SyntheticEditor())
            agent = Agent(
                name="Root",
                model=model,
                model_settings=make_model_settings(
                    None,
                    model_name="openai/gpt-6-luna",
                    bounded_budget=True,
                    max_output_tokens=128,
                ),
                tools=[tool],
            )
            response = await Runner.run(
                agent,
                "offline",
                context={"agent_id": "root"},
                hooks=hooks,
                run_config=RunConfig(tracing_disabled=True),
            )
        else:
            response = await _run(
                model,
                streaming=os.environ["PROBE_STREAM"] == "1",
                hooks=hooks,
            )
        assert response.final_output == "OK", response.final_output


asyncio.run(main())
