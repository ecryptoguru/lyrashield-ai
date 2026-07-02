# AG Kit Scripts

Master validation and utility scripts for the AG Kit system.

## Master Scripts

| Script             | Purpose                              | Usage                                      |
| ------------------ | ------------------------------------ | ------------------------------------------ |
| `checklist.py`     | Priority-based validation suite      | `python .devin/scripts/checklist.py .`  |
| `verify_all.py`    | Full verification (pre-deployment) | `python .devin/scripts/verify_all.py .` |
| `auto_preview.py`  | Start/stop local dev server          | `python .devin/scripts/auto_preview.py` |
| `session_manager.py` | Project status & tech stack        | `python .devin/scripts/session_manager.py status` |

## Skill Scripts

Individual validation scripts live under `.devin/skills/<skill>/scripts/`.

| Category     | Scripts                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| Security     | `security_scan.py`, `dependency_analyzer.py`                            |
| Lint         | `lint_runner.py`, `type_coverage.py`                                    |
| Database     | `schema_validator.py`                                                   |
| Testing      | `test_runner.py`                                                        |
| UX           | `ux_audit.py`, `accessibility_checker.py`                               |
| SEO          | `seo_checker.py`, `geo_checker.py`                                      |
| Performance  | `lighthouse_audit.py`, `bundle_analyzer.py`                             |
| E2E          | `playwright_runner.py`                                                  |
| Mobile       | `mobile_audit.py`                                                       |
| i18n         | `i18n_checker.py`                                                       |

All scripts accept a project path as the first argument.
