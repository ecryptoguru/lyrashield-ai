# Batch 3 research and claim map

Research date: 2026-07-17
Status: source review complete, drafting and review in progress
Scope: topics 36 through 52

## Method

Research prioritized standards bodies, official product documentation, protocol specifications, and original research. Search snippets were not treated as evidence. Fast-changing vendor pages are dated below and must be checked again during final technical review.

Evidence labels used in the claim maps:

- **Official control:** a standard, protocol requirement, or first-party product behavior.
- **Demonstrated behavior:** behavior measured or reproduced in a cited study. It applies to the study setup, not automatically to every model or deployment.
- **Architecture-dependent inference:** a plausible risk derived from permissions, data flow, or trust boundaries. The draft must state the conditions required for it to occur.

## Source bank

### Operations and recovery

- **S01. OWASP Logging Cheat Sheet.** OWASP Cheat Sheet Series. Current page, no publication date shown; accessed 2026-07-17. https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- **S02. Implement Security Logging and Monitoring.** OWASP Developer Guide. Current page, no publication date shown; accessed 2026-07-17. https://devguide.owasp.org/en/04-design/02-web-app-checklist/09-logging-monitoring/
- **S03. NIST SP 800-92, Guide to Computer Security Log Management.** NIST, September 2006. https://csrc.nist.gov/pubs/sp/800/92/final
- **S04. NIST Cybersecurity Framework 2.0.** NIST, February 26, 2024. https://www.nist.gov/cyberframework
- **S05. NIST SP 800-34 Rev. 1, Contingency Planning Guide for Federal Information Systems.** NIST, May 2010, updated November 11, 2010. https://csrc.nist.gov/pubs/sp/800/34/r1/upd1/final
- **S06. StopRansomware Guide.** CISA and partners, updated September 2023; accessed 2026-07-17. https://www.cisa.gov/stopransomware/ransomware-guide
- **S07. Back up data.** AWS Well-Architected Reliability Pillar. Current documentation, accessed 2026-07-17. https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_planning_for_recovery_backup.html

### Dependencies and package installation

- **S08. Dependabot alerts.** GitHub Docs. Current documentation, accessed 2026-07-17. https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-alerts
- **S09. Dependency review.** GitHub Docs. Current documentation, accessed 2026-07-17. https://docs.github.com/en/code-security/concepts/supply-chain-security/dependency-review
- **S10. OSV API.** OSV.dev documentation. Current documentation, accessed 2026-07-17. https://google.github.io/osv.dev/api/
- **S11. Vulnerable Dependency Management Cheat Sheet.** OWASP Cheat Sheet Series. Current page, no publication date shown; accessed 2026-07-17. https://cheatsheetseries.owasp.org/cheatsheets/Vulnerable_Dependency_Management_Cheat_Sheet.html
- **S12. NIST SP 800-218, Secure Software Development Framework Version 1.1.** NIST, February 2022. https://csrc.nist.gov/pubs/sp/800/218/final
- **S13. We Have a Package for You! A Comprehensive Analysis of Package Hallucinations by Code Generating LLMs.** Spracklen et al., arXiv preprint submitted June 14, 2024, later presented at USENIX Security 2025. https://arxiv.org/abs/2406.10279
- **S14. USENIX Security 2025 presentation for We Have a Package for You!** USENIX, August 2025. https://www.usenix.org/conference/usenixsecurity25/presentation/spracklen
- **S15. npm view command.** npm CLI v11 documentation, current page accessed 2026-07-17. https://docs.npmjs.com/cli/v11/commands/npm-view/
- **S16. PyPI JSON API.** Python Package Index documentation, current page accessed 2026-07-17. https://docs.pypi.org/api/json/
- **S17. npm scripts.** npm CLI v11 documentation, current page accessed 2026-07-17. https://docs.npmjs.com/cli/v11/using-npm/scripts/
- **S18. npm configuration, `ignore-scripts`.** npm CLI v11 documentation, current page accessed 2026-07-17. https://docs.npmjs.com/cli/v11/using-npm/config/#ignore-scripts
- **S19. SLSA threats overview.** Supply-chain Levels for Software Artifacts specification 1.1, accessed 2026-07-17. https://slsa.dev/spec/v1.1/threats-overview

### Secrets and AI-tool data handling

- **S20. SEC03-BP02 Grant least privilege access.** AWS Well-Architected Framework, current page accessed 2026-07-17. https://docs.aws.amazon.com/wellarchitected/latest/framework/sec_permissions_least_privileges.html
- **S21. Secrets Management Cheat Sheet.** OWASP Cheat Sheet Series. Current page, no publication date shown; accessed 2026-07-17. https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html
- **S22. Data Use and Privacy Overview.** Cursor, last updated July 15, 2026. https://cursor.com/data-use
- **S23. Security.** Cursor, last updated April 24, 2026. https://cursor.com/security
- **S24. Data controls in the OpenAI platform.** OpenAI API documentation, current page accessed 2026-07-17. https://platform.openai.com/docs/guides/your-data
- **S25. NIST Privacy Framework.** NIST, version 1.0 published January 16, 2020; current project page accessed 2026-07-17. https://www.nist.gov/privacy-framework

### Prompt injection and agents

- **S26. LLM Prompt Injection Prevention Cheat Sheet.** OWASP Cheat Sheet Series. Current page, no publication date shown; accessed 2026-07-17. https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html
- **S27. AI Agent Security Cheat Sheet.** OWASP Cheat Sheet Series. Current page, no publication date shown; accessed 2026-07-17. https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html
- **S28. NIST AI 100-2e2025, Adversarial Machine Learning: A Taxonomy and Terminology of Attacks and Mitigations.** NIST, March 24, 2025. https://doi.org/10.6028/NIST.AI.100-2e2025
- **S29. More than you've asked for: A Comprehensive Analysis of Novel Prompt Injection Threats to Application-Integrated Large Language Models.** Greshake et al., arXiv preprint submitted February 23, 2023. https://arxiv.org/abs/2302.12173

### MCP and delegated tools

- **S30. Model Context Protocol: Tools.** Protocol specification version 2025-06-18. https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- **S31. Model Context Protocol: Authorization.** Protocol specification version 2025-06-18. https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
- **S32. Model Context Protocol Security Best Practices.** Current official documentation, accessed 2026-07-17. https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices
- **S33. RFC 8707, Resource Indicators for OAuth 2.0.** IETF, January 2020. https://www.rfc-editor.org/rfc/rfc8707

### Runtime isolation and production permissions

- **S34. Rootless mode.** Docker Docs, current page accessed 2026-07-17. https://docs.docker.com/engine/security/rootless/
- **S35. Seccomp security profiles for Docker.** Docker Docs, current page accessed 2026-07-17. https://docs.docker.com/engine/security/seccomp/
- **S36. NIST SP 800-190, Application Container Security Guide.** NIST, September 2017. https://csrc.nist.gov/pubs/sp/800/190/final
- **S37. IAM permissions boundaries.** AWS Identity and Access Management documentation, current page accessed 2026-07-17. https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html
- **S38. Controlling access to AWS resources using policies.** AWS Identity and Access Management documentation, current page accessed 2026-07-17. https://docs.aws.amazon.com/IAM/latest/UserGuide/access_controlling.html
- **S39. Deployment environments.** GitHub Docs, current page accessed 2026-07-17. https://docs.github.com/en/actions/concepts/workflows-and-actions/deployment-environments

### Rules files and repository change control

- **S40. Rules.** Cursor documentation, current page accessed 2026-07-17. https://cursor.com/docs/rules
- **S41. About code owners.** GitHub Docs, current page accessed 2026-07-17. https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners
- **S42. About protected branches.** GitHub Docs, current page accessed 2026-07-17. https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches

### Testing, verification, and silent failure

- **S43. NIST SP 800-218, Secure Software Development Framework Version 1.1.** NIST, February 2022. https://csrc.nist.gov/pubs/sp/800/218/final
- **S44. Secure Coding with AI Cheat Sheet.** OWASP Cheat Sheet Series. Current page, no publication date shown; accessed 2026-07-17. https://cheatsheetseries.owasp.org/cheatsheets/Secure_Coding_with_AI_Cheat_Sheet.html
- **S45. OWASP Application Security Verification Standard.** OWASP, current project page accessed 2026-07-17. https://owasp.org/www-project-application-security-verification-standard/
- **S46. The Illusion of Safety: Multi-Tier Verification of AI vs. Human C++ Code.** arXiv preprint submitted June 30, 2026. https://arxiv.org/abs/2607.00107

### CI authority and confused deputy

- **S47. CWE-441: Unintended Proxy or Intermediary, Confused Deputy.** MITRE CWE 4.20, page last updated April 30, 2026. https://cwe.mitre.org/data/definitions/441.html
- **S48. Secure use reference for GitHub Actions.** GitHub Docs, current page accessed 2026-07-17. https://docs.github.com/en/actions/reference/security/secure-use
- **S49. OpenID Connect in cloud providers.** GitHub Docs, current page accessed 2026-07-17. https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-cloud-providers

### Multi-agent propagation

- **S50. Prompt Infection: LLM-to-LLM Prompt Injection within Multi-Agent Systems.** Lee and Tiwari, arXiv preprint submitted October 9, 2024. https://arxiv.org/abs/2410.07283
- **S51. Securing Multi-Agent Systems: An Empirical Analysis of Security Prompt Hardening and Residual Risks.** Google Research publication page, current page accessed 2026-07-17. https://research.google/pubs/securing-multi-agent-systems-an-empirical-analysis-of-security-prompt-hardening-and-residual-risks/
- **S52. IPIGuard: A Novel Tool Dependency Graph-Based Defense Against Indirect Prompt Injection in LLM Agents.** EMNLP 2025. https://aclanthology.org/2025.emnlp-main.53/

### Placeholder logic and accountable review

- **S53. LLM verification-evasion patterns in AI-assisted software development: A taxonomy and implications for developer trust.** Information and Software Technology, 2026, article 108251. https://doi.org/10.1016/j.infsof.2026.108251
- **S54. Is Vibe Coding the Future? An Empirical Assessment of LLM Generated Codes for Construction Safety.** arXiv preprint submitted April 14, 2026. https://arxiv.org/abs/2604.12311
- **S55. CWE-754: Improper Check for Unusual or Exceptional Conditions.** MITRE CWE, current page accessed 2026-07-17. https://cwe.mitre.org/data/definitions/754.html
- **S56. Threat Modeling Cheat Sheet.** OWASP Cheat Sheet Series. Current page, no publication date shown; accessed 2026-07-17. https://cheatsheetseries.owasp.org/cheatsheets/Threat_Modeling_Cheat_Sheet.html
- **S57. The vibe coding spectrum approach to AI-assisted software development.** UK National Cyber Security Centre, June 2026. https://www.ncsc.gov.uk/sites/default/files/2026-06/The-vibe-coding-spectrum-approach-to-AI-assisted-software-development.pdf
- **S58. Threat Modeling Manifesto.** Threat Modeling Manifesto working group, 2020; current site accessed 2026-07-17. https://www.threatmodelingmanifesto.org/
- **S59. Using Agent in CLI.** Cursor documentation, current page accessed 2026-07-17. https://docs.cursor.com/en/cli/using

## Per-article claim maps

### 36. `security-monitoring-ai-apps`

1. **Official control:** Application security logging should cover security events, exclude or mask secrets and sensitive data, and be tested for failure and tampering. Sources: S01, S02.
2. **Official control:** Log collection needs management, protection, and response processes, not only file creation. Sources: S01, S03, S04.
3. **Architecture-dependent inference:** An alert has operational value only if it is routed to an owner and tested end to end. This follows from OWASP's monitoring and response guidance, but the right events and thresholds depend on the app. Sources: S01, S02.
4. **Limit statement:** A log or alert does not establish that a finding is exploitable, independently verified, or resolved. Source: LyraShield evidence-state contract, not an external prevalence claim.

### 37. `backup-restore-agentic-apps`

1. **Official control:** Contingency planning includes backup, recovery objectives, and testing the plan. Source: S05.
2. **Official control:** Backups should be protected and recoverable; ransomware guidance recommends offline or otherwise protected copies and restoration planning. Sources: S06, S07.
3. **Architecture-dependent inference:** Requiring a successful isolated restore before granting an agent destructive production access reduces impact but does not prevent deletion. Sources: S05, S20.
4. **Limit statement:** Snapshot existence is not restore proof. The draft must require opening the restored application data and checking integrity against defined assertions. Sources: S05, S07.

### 38. `ai-dependency-vulnerability-audit`

1. **Official control:** GitHub dependency review reports dependency changes and can fail a check when a pull request introduces a vulnerable package. Source: S09.
2. **Official behavior:** Dependabot matches resolved dependencies to advisory data, with coverage and ecosystem limitations. Sources: S08, S10.
3. **Official control:** Secure development includes maintaining and reviewing third-party components. Sources: S11, S12.
4. **Limit statement:** A clean SCA result means no covered advisory match was found for the resolved graph. It does not establish package identity, reachability, absence of malicious behavior, or runtime safety. Sources: S08, S10, S11.

### 39. `hallucinated-packages-slopsquatting`

1. **Demonstrated behavior:** Spracklen et al. measured nonexistent package recommendations across a defined set of models, languages, prompts, and repetitions. Use only figures from the final paper and identify that setup. Sources: S13, S14.
2. **Architecture-dependent inference:** An attacker can exploit a recurrent nonexistent name only if the name is available, registered, suggested again, trusted, and installed. Do not call every hallucination a compromise. Source: S13.
3. **Official behavior:** npm and PyPI expose registry metadata that can be checked before installation. Sources: S15, S16.
4. **Limit statement:** Registry existence or a successful install does not establish benign ownership or behavior. Source: S19 plus the paper's threat model.

### 40. `install-script-supply-chain-security`

1. **Official behavior:** npm supports lifecycle scripts that can run during install and build-related phases. Source: S17.
2. **Official behavior:** npm's `ignore-scripts` setting stops automatic package scripts, with documented exceptions for explicitly invoked scripts. Source: S18.
3. **Official control:** Dependency changes should be reviewed before introduction, and supply-chain threats include compromised build or dependency steps. Sources: S09, S19.
4. **Limit statement:** Disabling lifecycle scripts can break legitimate installation and does not prevent malicious runtime code. This is a direct scope conclusion from S17 and S18, not a claim that one npm setting secures the supply chain.

### 41. `secrets-ai-coding-prompts`

1. **Official control:** Secrets should be inventoried, stored outside source, rotated, and kept out of inappropriate logging or sharing paths. Source: S21.
2. **Official vendor behavior, dated:** Cursor states that Privacy Mode, indexing, temporary caching, and provider handling affect how code data is processed. Use the July 15, 2026 and April 24, 2026 wording only after final recheck. Sources: S22, S23.
3. **Official vendor behavior, dated:** OpenAI documents endpoint-specific retention and data-control behavior. Do not generalize API terms to every consumer or third-party product. Source: S24.
4. **Architecture-dependent inference:** Connected tools, indexing, and retrieved context can expose more data than the literal prompt. The actual set depends on product configuration and enabled integrations. Sources: S22, S23.
5. **Control boundary:** Live credentials and bearer tokens remain prohibited. Customer records, regulated personal data, and production logs require a formally approved, minimized workflow whose contractual and technical controls permit that data class. Sources: S21, S24, S25.
6. **Limit statement:** `.cursorignore` and redaction are risk-reduction measures, not proof that a secret never left the device. Sources: S22, S23.

### 42. `indirect-prompt-injection-coding-agents`

1. **Official guidance:** OWASP defines indirect injection through external content such as documents, code comments, issues, web pages, and tool output. Sources: S26, S27.
2. **Demonstrated behavior:** Greshake et al. demonstrated indirect prompt injection against selected application-integrated language-model setups. State the tested systems and date rather than universalizing the result. Source: S29.
3. **Official taxonomy:** NIST includes prompt injection and agent exposure in its adversarial machine learning taxonomy and notes that mitigations have limitations. Source: S28.
4. **Architecture-dependent inference:** A harmful outcome requires an agent to read injected content and possess a reachable action or disclosure path. Tool scope and approval boundaries determine impact. Sources: S27, S29.

### 43. `least-privilege-mcp-tools`

1. **Official protocol behavior:** MCP tools are model-controlled; the specification recommends visible tool exposure, invocation indicators, and human ability to deny calls. Source: S30.
2. **Official protocol requirement:** Tool annotations must be treated as untrusted unless they come from trusted servers, and structured outputs should be validated when a schema is supplied. Source: S30.
3. **Official protocol requirement:** MCP authorization requires resource-bound token handling, audience validation, and no token passthrough under the 2025-06-18 specification. Sources: S31, S33.
4. **Official guidance:** MCP security guidance covers token theft, confused deputy risks, and tool-set changes. Source: S32.
5. **Limit statement:** MCP protocol conformance does not itself enforce business authorization, filesystem boundaries, per-resource scopes, or approval policy. Sources: S30, S31.

### 44. `coding-agent-sandbox-egress`

1. **Official control:** Rootless container operation reduces daemon and container privilege relative to rootful defaults. Source: S34.
2. **Official control:** Docker's default seccomp profile restricts selected system calls, but it is one runtime layer. Source: S35.
3. **Official guidance:** NIST container security treats images, registries, orchestrators, hosts, and runtime controls as separate risk areas. Source: S36.
4. **Architecture-dependent inference:** A container with unrestricted outbound networking can still send accessible data to external destinations. Egress policy therefore addresses a different path than filesystem isolation. Sources: S27, S36.
5. **Limit statement:** Do not call a default container a complete sandbox or claim a destination allowlist prevents every covert channel.

### 45. `agent-production-permissions`

1. **Official control:** Least privilege restricts identities to necessary actions, resources, and conditions and should be refined over time. Sources: S20, S38.
2. **Official behavior:** An IAM permissions boundary sets maximum effective permissions but grants no permission by itself. Source: S37.
3. **Official behavior:** GitHub deployment environments can limit secrets, branches, and approval before a deployment job proceeds. Source: S39.
4. **Architecture-dependent inference:** Exact-action approval, short-lived elevation, and a separate agent identity reduce standing authority. They still depend on correct server-side binding and ingress controls. Sources: S37, S39.
5. **Limit statement:** Backups and audit logs reduce recovery and investigation cost but do not make unrestricted delete authority safe.

### 46. `agent-rules-file-security`

1. **Official vendor behavior, dated:** Cursor rules and root `AGENTS.md` content can be loaded as persistent project instructions, with rule scopes defined by the product. Source: S40.
2. **Official repository control:** CODEOWNERS can request responsible reviewers for path changes, and protected-branch settings can require review. Sources: S41, S42.
3. **Architecture-dependent inference:** If a rules file is loaded into agent context and an attacker can change it, the change can influence future agent behavior. Impact depends on merge controls, rule precedence, agent permissions, and user approval. Sources: S27, S40.
4. **Limit statement:** A secret scanner can find credential-like strings in a rules file but cannot decide whether an instruction is malicious or authorized.

### 47. `ai-generated-tests-security`

1. **Official control:** The SSDF calls for review, analysis, and testing of executable code and remediation of discovered vulnerabilities. Source: S43.
2. **Official guidance:** OWASP's AI coding guidance requires review and testing rather than trust in generated output. Source: S44.
3. **Official verification model:** ASVS provides testable application-security requirements, which can supply independent invariants beyond generated happy paths. Source: S45.
4. **Demonstrated behavior:** The 2026 multi-tier study found differences between passing tests, static findings, and confirmed runtime violations in its C++ task set. Report only the study's scoped results. Source: S46.
5. **Limit statement:** Passing generated tests is neither independent verification nor a security guarantee. A clean deterministic retest can be retest-confirmed only within documented coverage.

### 48. `cicd-agent-confused-deputy`

1. **Official definition:** CWE-441 describes a deputy that forwards or performs a request with authority unavailable to the original requester while losing the requester's identity or intent. Source: S47.
2. **Official platform guidance:** GitHub warns that privileged triggers combined with untrusted checkout can expose repository secrets or write access. Source: S48.
3. **Official platform control:** GitHub environments can gate deployment and limit secret availability. Source: S39.
4. **Official platform control:** OIDC avoids long-lived cloud secrets and supports claims that bind a workload identity to its intended context. Source: S49.
5. **Architecture-dependent inference:** A workflow is not a confused deputy merely because it uses an agent. The risk requires untrusted influence plus a privileged action outside the submitter's authority.

### 49. `multi-agent-prompt-injection`

1. **Demonstrated behavior:** Prompt Infection demonstrated self-propagating injected instructions in the paper's multi-agent configurations. State the topology, models, and test assumptions from the paper. Source: S50.
2. **Demonstrated behavior:** Google's empirical work evaluates prompt hardening and residual risk in selected multi-agent systems. Do not convert residual risk into a universal failure rate. Source: S51.
3. **Demonstrated defense research:** IPIGuard models tool dependencies to restrict actions affected by untrusted content in its evaluated agent setup. Source: S52.
4. **Architecture-dependent inference:** Structured messages, preserved provenance, and capability-separated readers and actors can break specific propagation paths, but no cited source establishes complete prevention across all architectures. Sources: S27, S50, S52.
5. **Limit statement:** Use `demonstrated in research systems`, never `agents spread prompt injection like a virus` as an unqualified production claim.

### 50. `placeholder-logic-silent-failures`

1. **Demonstrated behavior:** The verification-evasion taxonomy reports patterns such as claiming tests ran, leaving placeholders, or avoiding requested verification in its studied AI-assisted development interactions. Source: S53.
2. **Demonstrated behavior:** The construction-safety study reports silent calculation failures in a narrow domain, prompt set, and model set. It may illustrate the category but cannot establish a general software failure rate. Source: S54.
3. **Official weakness model:** CWE-754 covers failures to detect or handle unusual and exceptional conditions. Source: S55.
4. **Official control:** Secure development requires code review and executable testing rather than accepting plausible responses. Source: S43.
5. **Architecture-dependent inference:** Verifying durable state and business invariants catches some false-success paths that response-only tests miss. The necessary invariants are domain-specific.

### 51. `human-review-threat-model-vibe-coding`

1. **Official guidance:** OWASP presents threat modeling as a structured, repeatable process that models the system, identifies threats, chooses responses, and reviews the result. Source: S56.
2. **Official control:** NIST SSDF includes risk modeling during design and review throughout development. Source: S43.
3. **Official current guidance:** The NCSC's June 2026 vibe-coding spectrum ties the amount of AI autonomy and the sensitivity of the work to required control and review. Source: S57.
4. **Primary methodology:** The Threat Modeling Manifesto provides the four-question frame and working values. Source: S58.
5. **Limit statement:** Human approval is not evidence by itself. The reviewer must understand scope, data flow, permissions, threats, and the evidence used for release.

### 52. `cursor-app-security-checklist`

1. **Official vendor behavior, dated:** Cursor's July 15, 2026 data-use page describes Privacy Mode, provider handling, indexing, and temporary caching. Recheck before publication. Source: S22.
2. **Official vendor behavior, dated:** Cursor's April 24, 2026 security page describes client and agent security boundaries and points to current hardening documentation. Source: S23.
3. **Official vendor behavior:** Cursor project rules and root instruction files can affect agent context. Source: S40.
4. **Official vendor behavior:** Cursor CLI can read project rules and root instruction files and asks for command approval in interactive use; non-interactive mode has different behavior. Source: S59.
5. **Architecture-dependent inference:** Cursor configuration can reduce data and agent risk, but app authorization, dependency integrity, runtime isolation, and deployed-surface verification remain application responsibilities. Sources: S22, S23, S40, plus S09, S43.

## Research gaps and publication cautions

- Cursor documentation changes quickly. Reopen S22, S23, S40, and S59 on the final review date and record any changed wording in `updatedDate` notes.
- The MCP specification cited here is version 2025-06-18. If a later stable version is adopted before publication, update all MCP claims together rather than mixing versions.
- The package-hallucination article may use numeric results only after checking the USENIX paper itself. Do not use figures from vendor blogs or news summaries.
- The 2026 studies in S46, S53, and S54 are scoped evidence. Their results cannot be presented as prevalence across AI-generated software.
- No source establishes that every coding agent follows malicious repository instructions or that prompt injection always propagates across agents. The drafts must state the required architecture and permissions.
- Container and egress examples should remain vendor-neutral. Product-specific sandbox defaults need fresh first-party verification if added later.
- External links should be checked again in the batch release gate. Several official documentation sites redirect versioned URLs while retaining equivalent content.

## Source-count gate

Every Batch 3 article has at least three authoritative sources and at least two primary or official sources in its claim map. Original studies are used only for behavior they directly evaluated. The batch currently references 59 distinct source records, with intentional reuse of baseline standards across related articles.
