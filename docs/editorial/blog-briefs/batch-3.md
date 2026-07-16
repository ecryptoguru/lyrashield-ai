# Batch 3 editorial briefs

Date: 2026-07-17
Status: research complete, drafting and review in progress
Owner: LyraShield Team
Scope: topics 36 through 52 from the approved 100-article program

## Batch intent

Batch 3 moves from preventive application controls into operations, software supply chain, coding-agent boundaries, and verification. Each article must solve one narrow reader problem. The articles may share standards and examples, but they must not collapse into a generic AI security checklist.

All public drafts must link to `/blog/vibe-coding-security-guide` in the first third. Source IDs below resolve to full citations and claim maps in `docs/editorial/blog-research/batch-3.md`. The tool CTAs are browser-local checks and must retain their stated limitations.

## 36. Monitoring and Alerts Before Launch

- Slug: `security-monitoring-ai-apps`
- Primary query: `app security monitoring checklist`
- Search intent: How-to
- Target length: 1,350 words
- Reader problem: The app records generic errors or provider logs, but nobody has defined which security events matter, who receives an alert, or how to tell whether logging has stopped.
- Unique angle: Build a small launch-ready detection loop around application events and ownership. Do not turn the article into a SIEM buying guide or a general observability tutorial.
- Direct-answer thesis: Before launch, define a short list of security-relevant events, record enough context to investigate them without logging secrets, route high-severity signals to a named owner, and test both the alert and the failure path. Logs alone are not monitoring. A working alert must reach someone who can act.
- Entities: OWASP Logging Cheat Sheet, OWASP Developer Guide, NIST SP 800-92, application audit events, alert routing, retention, log injection, DNT and GPC privacy boundaries.
- Cannibalization check: Topic 36 owns launch monitoring design. Topic 85 owns the later weekly scan routine. Topic 86 owns response to a confirmed critical finding. Topic 93 owns public API endpoint hardening. Avoid weekly cadence, incident containment, and API-specific rate-limit detail here.
- Required sources: S01, S02, S03, S04.
- Authority link: Link from the opening control inventory to `/blog/vibe-coding-security-guide` with anchor `the six-layer vibe coding security guide`.
- Tool CTA: `/tools/ai-app-security-checklist`, positioned as a local documentation check, not evidence that alerts work.
- Related dependency: `/blog/sensitive-data-logging` from Batch 2 for event-field design. If that post is not yet public, keep this post private.
- FAQ decision: Include three questions on events to alert, secrets in logs, and whether cloud-provider logs are sufficient.
- Image cluster concept: Decision and operations. A sparse event stream entering a single amber decision gate, with one red signal routed to a raised response plane.

## 37. Prove Backup and Restore Before Agents Touch Production

- Slug: `backup-restore-agentic-apps`
- Primary query: `backup restore test`
- Search intent: How-to
- Target length: 1,400 words
- Reader problem: Backups are enabled, but the team has never restored a clean copy or measured whether it meets recovery objectives before granting an agent production access.
- Unique angle: Treat restore proof as a precondition for destructive automation. Focus on a safe isolated restore drill, integrity checks, recovery time, recovery point, and documented rollback authority.
- Direct-answer thesis: A backup is only useful after a restore test proves that the data can be recovered into an isolated environment, opened by the application, checked for integrity, and restored within the required time and data-loss window. Run that drill before any coding agent receives a production credential or destructive tool.
- Entities: NIST SP 800-34 Rev. 1, recovery time objective, recovery point objective, immutable or offline copies, restore drill, least privilege, production approval.
- Cannibalization check: Topic 37 owns backup recoverability. Topic 45 owns limiting destructive permissions. Topic 86 owns incident response. Topic 100 owns key exposure recovery. Permission examples may support the restore gate but must not replace the restore procedure.
- Required sources: S05, S06, S07, S20.
- Authority link: Link from the explanation of operational evidence to `/blog/vibe-coding-security-guide` with anchor `release assurance for AI-built applications`.
- Tool CTA: `/tools/ai-app-security-checklist`, using its operations item as a prompt for evidence collection.
- Related dependency: `/blog/agent-production-permissions` in this batch. The restore article should publish before that article links back to it.
- FAQ decision: Include four questions on backup frequency, restore frequency, test data safety, and whether provider snapshots count.
- Image cluster concept: Decision and operations. A sealed graphite archive opening into a clean green recovery chamber, with a measured path between them.

## 38. Audit AI-Suggested Dependencies for CVEs

- Slug: `ai-dependency-vulnerability-audit`
- Primary query: `ai generated dependencies security`
- Search intent: How-to
- Target length: 1,400 words
- Reader problem: An assistant added a plausible dependency and version, but the developer has not verified the package identity, resolved version, transitive graph, or known advisories.
- Unique angle: Separate package existence and provenance from known-vulnerability matching. Show why an SCA alert is a detected condition that still needs reachability, compatibility, and retest review.
- Direct-answer thesis: Verify every AI-suggested dependency in the official registry, lock the exact resolved version, inspect the full dependency diff, and compare resolved packages with current advisories. A clean vulnerability scan only means no matching advisory was found in its covered data. It does not prove the package is trustworthy or safe at runtime.
- Entities: GitHub dependency graph, Dependabot alerts, dependency review, GitHub Advisory Database, OSV, lockfiles, direct and transitive dependencies, known vulnerability.
- Cannibalization check: Topic 38 owns known-CVE review. Topic 39 owns nonexistent or impersonating packages. Topic 40 owns lifecycle scripts and transitive execution. Topic 74 owns pre-launch dependency scanning. Keep registry identity checks short and refer readers onward.
- Required sources: S08, S09, S10, S11, S12.
- Authority link: Link after distinguishing detection from proof to `/blog/vibe-coding-security-guide` with anchor `evidence-state model for security findings`.
- Tool CTA: `/tools/ai-app-security-checklist`, limited to documenting whether dependency review exists.
- Related dependency: `/blog/hallucinated-packages-slopsquatting` in this batch.
- FAQ decision: Include three questions on lockfiles, transitive dependencies, and what a clean SCA result means.
- Image cluster concept: Supply chain. A dependency lattice passing through a cyan advisory scanner while one amber node remains outside the known-vulnerability beam.

## 39. Hallucinated Packages and Slopsquatting

- Slug: `hallucinated-packages-slopsquatting`
- Primary query: `ai hallucinated package security`
- Search intent: Explainer with safe verification
- Target length: 1,350 words
- Reader problem: Generated code imports a package with a convincing name, and the developer assumes a successful install means the suggestion was legitimate.
- Unique angle: Explain the demonstrated package-hallucination behavior and the inferred attacker opportunity separately. Give a pre-install identity checklist without publishing malicious package names or install commands.
- Direct-answer thesis: A hallucinated package is a dependency name produced by a model even though the intended package does not exist. Slopsquatting is the risk that someone registers such a name and waits for a developer or agent to install it. Confirm the package in its official registry, repository, release history, and maintainer record before installation.
- Entities: package hallucination, slopsquatting, npm, PyPI, package registry metadata, provenance, Spracklen et al., lockfiles.
- Cannibalization check: Topic 39 owns package-name validity and the slopsquatting research. Topic 38 owns CVEs in real dependencies. Topic 40 owns install-script execution. Topic 78 owns the broader launch dependency scan. Avoid generic SCA instructions.
- Required sources: S13, S14, S15, S16.
- Authority link: Link from the pre-install gate to `/blog/vibe-coding-security-guide` with anchor `supply-chain layer of the security guide`.
- Tool CTA: `/tools/ai-app-security-checklist`, framed as a place to record package-review ownership, not a registry verifier.
- Related dependency: `/blog/ai-dependency-vulnerability-audit` in this batch.
- FAQ decision: Include four questions on meaning, difference from typosquatting, whether a successful install proves legitimacy, and safe verification.
- Image cluster concept: Supply chain. A near-identical graphite package sits beside a verified provenance chain, separated by a narrow red boundary.

## 40. Secure Install Scripts and Transitive Dependencies

- Slug: `install-script-supply-chain-security`
- Primary query: `npm postinstall security`
- Search intent: How-to
- Target length: 1,400 words
- Reader problem: A package install runs lifecycle code with developer or CI privileges before anyone has reviewed what it does.
- Unique angle: Make install-time execution visible. Use an isolated, non-secret-bearing inspection workflow and explain the tradeoff of disabling scripts rather than claiming it is universally safe.
- Direct-answer thesis: Treat dependency installation as code execution. Inspect lockfile changes and package metadata first, install in an isolated environment without production credentials, and block or explicitly allow lifecycle scripts according to project policy. Disabling scripts reduces one path but can break legitimate packages and does not remove risk from imported runtime code.
- Entities: npm lifecycle scripts, `ignore-scripts`, `allowScripts`, lockfiles, dependency review, transitive dependency, build runner credentials, provenance.
- Cannibalization check: Topic 40 owns installation-time code and transitive execution. Topic 38 owns advisory matching. Topic 39 owns hallucinated names. Topic 48 owns privileged workflow triggers. Keep CI workflow privilege detail as a link, not a second article.
- Required sources: S17, S18, S09, S19.
- Authority link: Link from the explanation of supply-chain execution to `/blog/vibe-coding-security-guide` with anchor `the guide's dependency and build controls`.
- Tool CTA: `/tools/ai-app-security-checklist`, framed as a place to document dependency-script ownership and release policy, not a package or lockfile inspector. Retain `/tools/secret-exposure-scanner` as a secondary selected-file check before a sandboxed install, and state that it cannot inspect process environment or Git history.
- Related dependency: `/blog/cicd-agent-confused-deputy` in this batch.
- FAQ decision: Include four questions on postinstall, disabling scripts, transitive packages, and safe CI installation.
- Image cluster concept: Supply chain. Nested dependency plates enter an isolation chamber while a restrained amber script path is held behind a gate.

## 41. What Never to Paste Into an AI Coding Tool

- Slug: `secrets-ai-coding-prompts`
- Primary query: `ai coding assistant privacy secrets`
- Search intent: Checklist
- Target length: 1,300 words
- Reader problem: Developers paste `.env` files, credentials, customer data, proprietary code, or production logs into a coding assistant without checking the provider, workspace, retention, and sharing settings.
- Unique angle: Give a data-classification decision before the prompt is sent. Explain that vendor privacy mode and API retention controls vary and can change, so the reader must verify the policy for the exact product and workspace.
- Direct-answer thesis: Never paste live credentials, private keys, session tokens, or customer secrets into a coding tool. Default to synthetic data for customer records, regulated personal data, and production logs. Use real, minimized content only through a formally approved workflow with verified contractual and technical controls for that data class.
- Entities: `.env`, secret, personal data, model context, data retention, abuse monitoring, Privacy Mode, codebase indexing, `.cursorignore`, data minimization.
- Cannibalization check: Topic 41 owns pre-prompt data handling. Topic 17 owns secrets in source and environment files. Topic 95 owns broader AI assistant privacy governance. Topic 100 owns credential incident response. Avoid a full provider comparison and rotation runbook.
- Required sources: S21, S22, S23, S24, S25.
- Authority link: Link from the sensitive-data inventory to `/blog/vibe-coding-security-guide` with anchor `data and secret boundaries in the security guide`.
- Tool CTA: `/tools/secret-exposure-scanner`, explicitly browser-local and limited to selected text files.
- Related dependency: `/blog/api-keys-frontend-ai-apps` from Batch 1.
- FAQ decision: Include four questions on `.env`, customer logs, privacy mode, and redacted examples.
- Image cluster concept: Agent security. A translucent context window stops at a sealed secret compartment while a small sanitized sample passes through.

## 42. Indirect Prompt Injection in Repositories and Web Pages

- Slug: `indirect-prompt-injection-coding-agents`
- Primary query: `coding agent prompt injection`
- Search intent: Explainer with defensive testing
- Target length: 1,450 words
- Reader problem: A coding agent reads issues, repository files, documentation, web pages, or tool output and may treat embedded text as instructions.
- Unique angle: Trace the trust-boundary failure from untrusted content to a privileged action. Use inert test strings and a canary action, never an exfiltration payload.
- Direct-answer thesis: Indirect prompt injection occurs when an agent reads untrusted content that contains instructions and then treats those instructions as part of its task. Defenses must constrain what the agent can read and do, keep untrusted data separate, require approval for sensitive actions, and test with harmless canaries. A prompt filter alone is not proof.
- Entities: OWASP LLM Prompt Injection Prevention, indirect prompt injection, issue body, repository documentation, tool output, action authorization, data-instruction separation, NIST AI 100-2.
- Cannibalization check: Topic 42 owns the single-agent indirect injection path. Topic 46 owns persistent rules files. Topic 49 owns cross-agent propagation. Topic 43 owns MCP permissions. Keep those as downstream controls.
- Required sources: S26, S27, S28, S29.
- Authority link: Link after the trust-boundary diagram to `/blog/vibe-coding-security-guide` with anchor `agent boundary in the vibe coding security guide`.
- Tool CTA: `/tools/ai-app-security-checklist`, using the agent-permission and review items only.
- Related dependency: `/blog/least-privilege-mcp-tools` in this batch.
- FAQ decision: Include four questions on direct versus indirect injection, hidden text, filters, and safe testing.
- Image cluster concept: Agent security. An untrusted document plane crosses into a tool path, but a cyan policy barrier diverts the embedded red instruction.

## 43. Least-Privilege MCP Tools

- Slug: `least-privilege-mcp-tools`
- Primary query: `mcp security permissions`
- Search intent: How-to
- Target length: 1,400 words
- Reader problem: An MCP server exposes broad filesystem, shell, network, or mutation tools, and the client treats tool descriptions or one approval as sufficient authorization.
- Unique angle: Convert least privilege into tool design: narrow verbs, constrained schemas, resource-bound tokens, separate read and write capabilities, explicit approval, and auditable results.
- Direct-answer thesis: Give an MCP client only the tools and resource scopes required for the current task. Split reads from mutations, validate every argument server-side, bind access tokens to the intended server, treat tool metadata as untrusted, and require a fresh human decision for destructive calls. Protocol support does not enforce these application controls for you.
- Entities: Model Context Protocol 2025-06-18, MCP tools, OAuth resource indicators, token audience, token passthrough, consent, tool annotations, schema validation.
- Cannibalization check: Topic 43 owns MCP tool and token scope. Topic 42 owns injected content. Topic 44 owns runtime sandbox and egress. Topic 77 later owns an MCP server security checklist. Keep this article conceptual and implementation-focused, not a complete server launch checklist.
- Required sources: S30, S31, S32, S33.
- Authority link: Link from the permission inventory to `/blog/vibe-coding-security-guide` with anchor `approval-gated agent security model`.
- Tool CTA: `/tools/ai-app-security-checklist`, framed as a local record of whether tool scopes and approvals have owners.
- Related dependency: `/blog/indirect-prompt-injection-coding-agents` in this batch.
- FAQ decision: Include four questions on MCP authorization, read-only tools, tool descriptions, and per-call approval.
- Image cluster concept: Agent security. Several narrow tool paths emerge from a scoped permission field, with the mutation path held behind a human approval lock.

## 44. Sandboxing and Egress Control for Coding Agents

- Slug: `coding-agent-sandbox-egress`
- Primary query: `coding agent sandbox security`
- Search intent: Guide
- Target length: 1,500 words
- Reader problem: A coding agent runs with host filesystem access and unrestricted outbound network access, so a bad command or injected instruction can reach secrets or external destinations.
- Unique angle: Treat sandboxing and egress as separate controls. Give a practical boundary model for disposable workspaces, minimal mounts, non-root execution, resource limits, destination allowlists, and artifact review.
- Direct-answer thesis: Run coding agents in a disposable environment with only the repository and credentials they need. Use a non-root identity, minimal mounts, process and resource limits, and an explicit outbound destination policy. A container alone is not a complete sandbox, and a sandbox without egress control can still send data to an external service.
- Entities: sandbox, container, rootless mode, seccomp, filesystem mount, network egress, DNS, ephemeral credential, approval, artifact promotion.
- Cannibalization check: Topic 44 owns runtime isolation and network reachability. Topic 45 owns production authorization. Topic 40 owns dependency installation. Topic 43 owns MCP tool scopes. Avoid provider-specific sandbox claims except dated examples.
- Required sources: S34, S35, S27, S36.
- Authority link: Link from the boundary model to `/blog/vibe-coding-security-guide` with anchor `agent execution boundaries in the security guide`.
- Tool CTA: `/tools/secret-exposure-scanner`, used before mounting selected configuration. State that a local file scan cannot verify isolation or egress.
- Related dependency: `/blog/agent-production-permissions` in this batch.
- FAQ decision: Include four questions on containers, internet blocking, secrets, and local agents.
- Image cluster concept: Agent security. A graphite execution chamber with a narrow repository mount and two explicitly permitted outbound beams, all other paths dark.

## 45. Keep AI Agents Away From Production Deletes

- Slug: `agent-production-permissions`
- Primary query: `ai agent database deletion prevention`
- Search intent: Guide
- Target length: 1,400 words
- Reader problem: An agent credential can delete tables, buckets, deployments, or environments because it inherited a human or CI administrator role.
- Unique angle: Design a fail-closed production action path using denied-by-default roles, permission boundaries, short-lived elevation, exact action previews, approval binding, audit records, and tested recovery.
- Direct-answer thesis: Do not give a coding agent standing production delete permission. Use a separate low-privilege identity, block destructive actions with a permissions boundary, require short-lived elevation and approval bound to the exact resource and action, and record the result. Backups reduce impact but do not make broad delete access acceptable.
- Entities: least privilege, AWS IAM permissions boundary, GitHub deployment environment, required reviewer, short-lived credential, exact approval binding, audit event, restore proof.
- Cannibalization check: Topic 45 owns destructive production authorization. Topic 37 owns restore tests. Topic 48 owns CI workflow authority. Topic 81 owns approval-gated fix proposals. Do not imply LyraShield executes automatic pull requests or production changes.
- Required sources: S37, S38, S39, S05.
- Authority link: Link from the exact-approval example to `/blog/vibe-coding-security-guide` with anchor `approval-bound fix and release controls`.
- Tool CTA: `/tools/ai-app-security-checklist`, limited to documenting whether production actions are separated and reviewed.
- Related dependency: `/blog/backup-restore-agentic-apps` in this batch.
- FAQ decision: Include four questions on read-only production access, break-glass roles, backups, and approval records.
- Image cluster concept: Agent security. A destructive red tool path terminates at a locked production boundary while a read-only cyan path continues.

## 46. Protect AGENTS.md and Rules Files From Poisoning

- Slug: `agent-rules-file-security`
- Primary query: `ai coding rules prompt injection`
- Search intent: Guide
- Target length: 1,400 words
- Reader problem: Repository instruction files influence agent behavior but may be changed in an ordinary pull request without ownership, provenance, or security review.
- Unique angle: Treat rules as policy-bearing code. Inventory which files and scopes are loaded by the chosen tool, protect them with review controls, inspect diffs, and test that a lower-trust file cannot silently expand authority.
- Direct-answer thesis: Protect agent rules like build and deployment configuration. Keep them versioned, assign code owners, require review for changes, limit their scope, and test which instruction wins when files conflict. A clean-looking rule can still redirect an agent, and file protection cannot compensate for an over-permissioned runtime.
- Entities: `AGENTS.md`, `.cursor/rules`, Cursor Project Rules, persistent context, path scope, CODEOWNERS, branch protection, prompt injection, provenance.
- Cannibalization check: Topic 46 owns persistent repository instructions and change control. Topic 42 owns untrusted issue or web content. Topic 49 owns propagation between agents. Topic 52 owns the wider Cursor launch checklist. Keep Cursor facts dated and do not generalize its behavior to every agent.
- Required sources: S40, S41, S27, S42.
- Authority link: Link from the policy-as-code model to `/blog/vibe-coding-security-guide` with anchor `change-control layer of the security guide`.
- Tool CTA: `/tools/secret-exposure-scanner`, for selected rule files only, with an explicit note that it detects credential patterns, not malicious instructions.
- Related dependency: `/blog/indirect-prompt-injection-coding-agents` in this batch.
- FAQ decision: Include four questions on whether `AGENTS.md` is trusted, code owners, nested rules, and prompt-injection scanners.
- Image cluster concept: Agent security. A stack of instruction planes passes through a provenance seal before entering the agent context.

## 47. Why AI-Generated Tests Are Not Security Proof

- Slug: `ai-generated-tests-security`
- Primary query: `ai generated tests security`
- Search intent: Explainer
- Target length: 1,350 words
- Reader problem: The same assistant wrote the implementation and its happy-path tests, and the team reads a green test run as proof that abuse cases and security invariants are covered.
- Unique angle: Separate test execution, coverage, independent verification, and proof. Show a safe mutation or negative-test exercise that can reveal a test which merely restates the generated behavior.
- Direct-answer thesis: AI-generated tests can be useful regression checks, but they are not independent security proof. They may repeat the implementation's assumptions, omit abuse cases, or pass against mocked behavior. Add human-defined invariants, negative tenant and authorization cases, mutation checks, and a fresh review that is separate from the generation context.
- Entities: NIST SSDF, security verification, generated tests, negative testing, mutation testing, independent reviewer, coverage receipt, retest-confirmed, inconclusive.
- Cannibalization check: Topic 47 owns the limits of generated tests. Topic 50 owns placeholder and silent business logic. Topic 79 owns interpreting scanner results. Topic 82 owns fresh retests. Use status terms precisely and avoid claiming a test proves exploitability.
- Required sources: S43, S44, S45, S46.
- Authority link: Link from the evidence-state distinction to `/blog/vibe-coding-security-guide` with anchor `how tests fit into release assurance`.
- Tool CTA: `/tools/ai-app-security-checklist`, used to document whether security tests and independent review exist.
- Related dependency: `/blog/human-review-threat-model-vibe-coding` in this batch.
- FAQ decision: Include four questions on unit tests, coverage, mutation testing, and independent verification.
- Image cluster concept: Verification. A green test ring surrounds an untested amber path that becomes visible only when a separate evidence beam crosses it.

## 48. Prevent CI/CD Agents From Becoming a Confused Deputy

- Slug: `cicd-agent-confused-deputy`
- Primary query: `agentic ci security`
- Search intent: Guide
- Target length: 1,450 words
- Reader problem: A workflow processes untrusted pull-request content while holding a write-capable token, deployment secret, privileged cache, or cloud credential.
- Unique angle: Apply the confused-deputy model to event triggers, caller identity, token permissions, untrusted checkout, OIDC audience, protected environments, and artifact promotion.
- Direct-answer thesis: A CI agent becomes a confused deputy when untrusted input causes a more privileged workflow to act with authority the submitter did not have. Keep untrusted code on read-only workflows, minimize `GITHUB_TOKEN` permissions, avoid privileged checkout patterns, use protected environments for deployment, and bind cloud credentials to the intended repository, workflow, and audience.
- Entities: CWE-441, GitHub Actions, `pull_request_target`, `workflow_run`, `GITHUB_TOKEN`, OIDC, environment protection, required reviewers, untrusted checkout.
- Cannibalization check: Topic 48 owns the CI authority transition. Topic 40 owns dependency install execution. Topic 45 owns direct production delete permission. Topic 75 owns GitHub Actions security as a platform article. This post must keep the confused-deputy reasoning central.
- Required sources: S47, S48, S39, S49.
- Authority link: Link from the caller-authority table to `/blog/vibe-coding-security-guide` with anchor `release gate model for AI-built code`.
- Tool CTA: `/tools/secret-exposure-scanner`, for selected workflow files only. State that it cannot evaluate effective token permissions or runner behavior.
- Related dependency: `/blog/install-script-supply-chain-security` in this batch.
- FAQ decision: Include four questions on `pull_request_target`, token permissions, OIDC, and self-hosted runners.
- Image cluster concept: Agent security. An untrusted pull-request path approaches a privileged deployment beam, with identity preserved through a narrow approval junction.

## 49. Stop Prompt Injection From Spreading Across Agents

- Slug: `multi-agent-prompt-injection`
- Primary query: `multi agent security`
- Search intent: Guide
- Target length: 1,400 words
- Reader problem: One agent summarizes untrusted content and passes it to a planner, reviewer, or executor, laundering an injected instruction into apparently trusted inter-agent output.
- Unique angle: Use provenance and capability separation at every handoff. Clearly state that propagation has been demonstrated in research systems, while the likelihood in a specific production architecture depends on topology, prompts, memory, tools, and policy.
- Direct-answer thesis: Treat every inter-agent message as untrusted unless its origin, schema, and allowed purpose are verified. Separate agents that read hostile content from agents that hold tools, pass structured data instead of free-form instructions, preserve provenance, and recheck proposed actions against the original user intent before execution.
- Entities: Prompt Infection, multi-agent system, message provenance, structured handoff, capability separation, tool dependency graph, indirect prompt injection, original user intent.
- Cannibalization check: Topic 49 owns propagation and trust at handoffs. Topic 42 owns first-stage indirect injection. Topic 43 owns MCP permissions. Topic 46 owns rules files. Do not claim self-replication is inevitable outside the studied setups.
- Required sources: S50, S51, S52, S27.
- Authority link: Link from the handoff trust model to `/blog/vibe-coding-security-guide` with anchor `the guide's agent and evidence boundaries`.
- Tool CTA: `/tools/ai-app-security-checklist`, limited to recording agent scopes, approvals, and test ownership.
- Related dependency: `/blog/indirect-prompt-injection-coding-agents` in this batch.
- FAQ decision: Include four questions on propagation evidence, structured messages, separate models, and human approval.
- Image cluster concept: Agent security. Three isolated agent chambers exchange signed evidence planes while a red instruction is quarantined at the first boundary.

## 50. Find Placeholder Logic and Silent Failures

- Slug: `placeholder-logic-silent-failures`
- Primary query: `ai generated code silent failure`
- Search intent: Guide
- Target length: 1,400 words
- Reader problem: Generated code compiles and returns plausible success values while using stubs, invented defaults, swallowed errors, fake persistence, or incorrect business calculations.
- Unique angle: Review the contract between user-visible success and durable state. Use an inert example with a fake success response, then verify state, error propagation, boundaries, and a clean retest.
- Direct-answer thesis: Search for TODOs, stubs, constant success values, empty catch blocks, invented defaults, and calculations without boundary tests. Then exercise the real state change and verify its durable result, not only the response. Static checks can flag patterns, but many silent failures require domain assertions and independent runtime evidence.
- Entities: placeholder logic, silent failure, business invariant, durable state, error handling, boundary value, verification evasion, runtime evidence, retest.
- Cannibalization check: Topic 50 owns false completion and silent business failure. Topic 47 owns weak tests. Topic 80 owns false positives. Topic 82 owns retest procedure. Avoid repeating generic test advice; center the mismatch between claimed and actual outcome.
- Required sources: S53, S54, S43, S55.
- Authority link: Link from the durable-outcome check to `/blog/vibe-coding-security-guide` with anchor `evidence states for generated code`.
- Tool CTA: `/tools/ai-app-security-checklist`, used to record whether critical workflows have explicit success and failure evidence.
- Related dependency: `/blog/ai-generated-tests-security` in this batch.
- FAQ decision: Include four questions on static analysis, TODO scans, mocked tests, and what counts as retest evidence.
- Image cluster concept: Verification. A polished success plane floats above a disconnected graphite state machine, with an amber gap revealed by a retest ring.

## 51. Human Review and Threat Modeling for Vibe Coding

- Slug: `human-review-threat-model-vibe-coding`
- Primary query: `vibe coding threat model`
- Search intent: Guide
- Target length: 1,450 words
- Reader problem: Nobody can explain the system's data flows, trust boundaries, abuse cases, or ownership because the application emerged from iterative prompts rather than an explicit design.
- Unique angle: Offer a lightweight, repeatable threat-model session for a small AI-built app. Start with actual data flows and permissions, not a large compliance template.
- Direct-answer thesis: Draw the app's users, data stores, external services, trust boundaries, and privileged actions. Ask what can go wrong at each boundary, choose an owner and response for each material threat, and turn those responses into tests or release gates. Human review is accountable reasoning, not a ceremonial approval click.
- Entities: OWASP Threat Modeling, Shostack four-question framework, NIST SSDF, data flow diagram, trust boundary, abuse case, risk response, review owner.
- Cannibalization check: Topic 51 owns the threat-model method and accountable review. Topic 1 is the broad authority guide. Topic 52 applies controls to Cursor. Topic 91 is aimed at solo founders. Keep this method usable by a small team but not persona-specific.
- Required sources: S56, S43, S57, S58.
- Authority link: Link after the initial system inventory to `/blog/vibe-coding-security-guide` with anchor `the complete vibe coding security model`.
- Tool CTA: `/tools/ai-app-security-checklist`, used after threat modeling to record control owners and missing evidence.
- Related dependency: `/blog/ai-generated-tests-security` in this batch.
- FAQ decision: Include four questions on who participates, session length, tool choice, and when to update the model.
- Image cluster concept: Verification. Human-scale evidence planes map data flows across three trust boundaries, with owned mitigations attached as green receipts.

## 52. Secure a Cursor-Built App Before Launch

- Slug: `cursor-app-security-checklist`
- Primary query: `cursor app security`
- Search intent: Checklist
- Target length: 1,400 words
- Reader problem: A developer built most of an app in Cursor and needs a launch sequence that covers data handling, rules, dependencies, application controls, agent permissions, and independent verification.
- Unique angle: Apply the prior Batch 3 controls to Cursor without implying Cursor generated every issue or that one setting secures the application. Date every product-specific fact and separate editor configuration from app security.
- Direct-answer thesis: Before launching a Cursor-built app, review what data entered Cursor, protect and inspect project rules, verify every dependency, test authorization and tenant boundaries, remove production credentials from agent reach, and run independent negative tests against the deployed surface. Cursor privacy or agent settings do not verify the security of the code it helped create.
- Entities: Cursor Privacy Mode, codebase indexing, `.cursorignore`, `.cursor/rules`, `AGENTS.md`, agent command approval, dependency review, application authorization, launch evidence.
- Cannibalization check: Topic 52 owns the Cursor-specific launch synthesis. Topics 41 and 46 own data and rules in depth. Topics 53 through 58 later own other coding tools. Avoid a generic tool comparison or unsupported claims about competing products.
- Required sources: S22, S23, S40, S41, S59.
- Authority link: Link from the six-part launch sequence to `/blog/vibe-coding-security-guide` with anchor `full security guide for AI-built apps`.
- Tool CTA: `/tools/ai-app-security-checklist`, as the primary local launch worksheet; also mention the secret scanner contextually without adding a second primary CTA.
- Related dependency: `/blog/secrets-ai-coding-prompts` in this batch.
- FAQ decision: Include four questions on Privacy Mode, `.cursorignore`, project rules, and whether green tests are enough.
- Image cluster concept: Decision and operations. A code workspace passes through six restrained launch gates and ends at an evidence receipt, with no Cursor logo or generated interface text.

## Batch-level overlap controls

- Topics 38, 39, and 40 form a deliberate sequence: known advisories, package identity, then install-time execution.
- Topics 42, 46, and 49 form another sequence: injected external content, persistent repository policy, then inter-agent propagation.
- Topics 43, 44, 45, and 48 divide authority by layer: tool scope, runtime containment, production permission, then workflow delegation.
- Topics 47, 50, and 51 divide assurance by question: whether tests prove security, whether success is real, and who owns the system threat model.
- Topic 52 is the only Cursor synthesis. Its internal links should carry readers into the narrower articles rather than repeating their full procedures.

## Drafting gate

Drafting may start only after the research record is reviewed for source quality and fast-changing vendor claims. Each draft still needs claim-by-claim citation placement, safe examples, Humanizer audit, image assignment, render QA, and individual publication approval.
