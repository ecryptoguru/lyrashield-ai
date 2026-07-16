# Batch 6 research and claim-to-source notes

Status: source review complete, drafting not started
Reviewed: 2026-07-17
Scope: topics 85 through 100

## Research rules

- Every supporting article uses at least three authoritative references, including at least two primary or official sources.
- All sources below are primary standards, official government publications, official project standards, or official vendor documentation. Vendor documentation supports only claims about that vendor.
- A framework or score is not converted into a claim it does not make. NIST CSF is outcome-based, CVSS describes severity, EPSS estimates exploitation probability for published CVEs, and TLP communicates sharing boundaries.
- Living documentation has an access date because its content can change. Dated standards retain both publication date and access date.
- Legal examples are not jurisdiction-specific legal advice. The GDPR source supports the stated EU requirements only.

## 85. `weekly-security-scan-workflow`

### Sources

| Source                                                     | Authority                       | Published or updated                      | Exact URL                                                                                       |
| ---------------------------------------------------------- | ------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| NIST SP 800-218, Secure Software Development Framework 1.1 | NIST final publication, primary | February 2022; accessed 2026-07-17        | https://csrc.nist.gov/pubs/sp/800/218/final                                                     |
| Workflow configuration options for code scanning           | GitHub official documentation   | Living documentation; accessed 2026-07-17 | https://docs.github.com/en/code-security/reference/code-scanning/workflow-configuration-options |
| Known Exploited Vulnerabilities Catalog                    | CISA official catalog           | Living catalog; accessed 2026-07-17       | https://www.cisa.gov/known-exploited-vulnerabilities-catalog                                    |

### Claim map

- Scheduled checks complement change-triggered checks because analysis capabilities and known vulnerabilities can change even when a repository is quiet: NIST SP 800-218 RV practices and GitHub scan-frequency guidance.
- GitHub's default CodeQL workflow scans once a week in addition to event triggers, and the schedule can be configured: GitHub workflow configuration documentation.
- Known exploitation should trigger reprioritization outside the normal cadence: CISA KEV catalog. Do not claim every KEV applies to the reader's application.

### Drafting cautions

- Do not present weekly as a universal optimum. Cadence depends on exposure, release frequency, scanner type, change rate, and response capacity.
- A successful scheduled run proves only that the configured checks ran against the configured target.

## 86. `critical-security-finding-response`

### Sources

| Source                                                                      | Authority                       | Published or updated                           | Exact URL                                                                        |
| --------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| NIST SP 800-61 Rev. 3, Incident Response Recommendations and Considerations | NIST final publication, primary | April 2025; accessed 2026-07-17                | https://csrc.nist.gov/pubs/sp/800/61/r3/final                                    |
| CISA Stakeholder-Specific Vulnerability Categorization Guide                | CISA official guidance          | Released 10 November 2022; accessed 2026-07-17 | https://www.cisa.gov/sites/default/files/publications/cisa-ssvc-guide%20508c.pdf |
| Known Exploited Vulnerabilities Catalog                                     | CISA official catalog           | Living catalog; accessed 2026-07-17            | https://www.cisa.gov/known-exploited-vulnerabilities-catalog                     |

### Claim map

- Incident response should be integrated with risk management and should preserve detection, response, recovery, and improvement information: NIST SP 800-61 Rev. 3.
- A response decision should consider exploitation status, technical impact, mission prevalence, and safety or public impact rather than severity alone: CISA SSVC.
- Confirmed known exploitation is a strong urgency input, but the affected product and version still need applicability review: CISA KEV.

### Drafting cautions

- Do not equate a scanner's `critical` label with confirmed exploitation or an incident.
- Advise immediate containment when active exposure or exploitation is credible, but avoid a universal shutdown instruction that could create safety or availability harm.

## 87. `ai-generated-code-production-safety`

### Sources

| Source                                                     | Authority                                           | Published or updated                      | Exact URL                                                                     |
| ---------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------- |
| NIST SP 800-218, Secure Software Development Framework 1.1 | NIST final publication, primary                     | February 2022; accessed 2026-07-17        | https://csrc.nist.gov/pubs/sp/800/218/final                                   |
| Guidelines for Secure AI System Development                | NCSC and international government partners, primary | 27 November 2023; accessed 2026-07-17     | https://www.ncsc.gov.uk/files/Guidelines-for-secure-AI-system-development.pdf |
| Responsible use of GitHub Copilot Chat in GitHub           | GitHub official documentation                       | Living documentation; accessed 2026-07-17 | https://docs.github.com/en/copilot/responsible-use/chat-in-github             |

### Claim map

- Secure development practices belong throughout the software life cycle, regardless of how code was authored: NIST SP 800-218.
- AI systems and AI-enabled development should use secure design, development, deployment, and operation practices, including restrictions on actions and sensitive data sent to external services: NCSC guidance.
- Generated code can be syntactically plausible but insecure and should be reviewed and tested: GitHub responsible-use documentation.

### Drafting cautions

- Do not claim that AI-generated code is categorically safer or less safe than human-written code.
- The article may state that origin does not remove the need for evidence. It must not imply a checklist or scan certifies production safety.

## 88. `prototype-to-production-security`

### Sources

| Source                                                     | Authority                       | Published or updated                                    | Exact URL                                                                 |
| ---------------------------------------------------------- | ------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| NIST SP 800-218, Secure Software Development Framework 1.1 | NIST final publication, primary | February 2022; accessed 2026-07-17                      | https://csrc.nist.gov/pubs/sp/800/218/final                               |
| OWASP Application Security Verification Standard 5.0.0     | OWASP official standard         | Version 5.0.0 released 30 May 2025; accessed 2026-07-17 | https://owasp.org/www-project-application-security-verification-standard/ |
| NIST Cybersecurity Framework 2.0                           | NIST final publication, primary | 26 February 2024; accessed 2026-07-17                   | https://www.nist.gov/publications/nist-cybersecurity-framework-csf-20     |

### Claim map

- Security requirements, protected development environments, secure production, and vulnerability response should be planned as software moves through its life cycle: NIST SP 800-218.
- ASVS supplies versioned technical verification requirements that can be selected according to application risk and assurance needs: OWASP ASVS 5.0.0.
- Governance, identification, protection, detection, response, and recovery outcomes all matter once an application creates material organizational risk: NIST CSF 2.0.

### Drafting cautions

- "Production" is defined editorially as material real-world consequence, not by a particular cloud environment.
- Do not say ASVS compliance or a CSF tier automatically makes an application secure.

## 89. `ai-coding-assistant-data-privacy`

### Sources

| Source                                             | Authority                         | Published or updated                                            | Exact URL                                                                                     |
| -------------------------------------------------- | --------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| NIST Privacy Framework 1.0                         | NIST official framework, primary  | January 2020; page updated 22 January 2024; accessed 2026-07-17 | https://www.nist.gov/privacy-framework/privacy-framework                                      |
| How your data is used to improve model performance | OpenAI official documentation     | Updated 2026-07-16; accessed 2026-07-17                         | https://help.openai.com/en/articles/5722486-api-data-usage-policies                           |
| Content exclusion for GitHub Copilot               | GitHub official documentation     | Living documentation; accessed 2026-07-17                       | https://docs.github.com/en/enterprise-cloud@latest/copilot/concepts/context/content-exclusion |
| Is my data used for model training?                | Anthropic official Privacy Center | 16 March 2026; accessed 2026-07-17                              | https://privacy.anthropic.com/en/articles/10023580-is-my-data-used-for-model-training         |

### Claim map

- Privacy risk management starts with data processing, purposes, governance, and controls rather than a generic "private" label: NIST Privacy Framework.
- OpenAI distinguishes individual products from business products and the API, and settings such as training opt-out and feedback can affect use: OpenAI data-use documentation. Recheck at publication because the page is living documentation.
- GitHub content exclusion can prevent selected files from informing suggestions, chat, or code review for supported organization plans: GitHub documentation. Do not generalize the feature to every plan or feature.
- Anthropic distinguishes consumer and commercial product handling and documents consumer opt-in and safety-review cases: Anthropic Privacy Center. Do not merge this with OpenAI or GitHub policy.

### Drafting cautions

- Use a comparison table only if every row is checked against current official documentation immediately before publication.
- "Not used for training" does not by itself establish zero retention, no human access, legal compliance, or authorization to submit the content.

## 90. `review-ai-generated-pull-request`

### Sources

| Source                                                     | Authority                         | Published or updated                      | Exact URL                                                                                                                                                 |
| ---------------------------------------------------------- | --------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reviewing proposed changes in a pull request               | GitHub official documentation     | Living documentation; accessed 2026-07-17 | https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/reviewing-proposed-changes-in-a-pull-request |
| Secure Code Review Cheat Sheet                             | OWASP official Cheat Sheet Series | Living guidance; accessed 2026-07-17      | https://cheatsheetseries.owasp.org/cheatsheets/Secure_Code_Review_Cheat_Sheet.html                                                                        |
| NIST SP 800-218, Secure Software Development Framework 1.1 | NIST final publication, primary   | February 2022; accessed 2026-07-17        | https://csrc.nist.gov/pubs/sp/800/218/final                                                                                                               |

### Claim map

- Reviewers should understand intent, inspect changed files, review dependency changes, and explicitly approve or request changes: GitHub PR review documentation.
- Manual review is valuable for business logic, data flow, authorization, trust boundaries, and other context that automated tools can miss: OWASP Secure Code Review Cheat Sheet.
- Code review and analysis should be risk-based, with review of human-readable code and executable forms where applicable: NIST SSDF PW practices.

### Drafting cautions

- AI can assist with summary or review, but an AI summary is not evidence that every relevant file or behavior was inspected.
- Do not repeat topic 75's automated GitHub diff gate. This article is the human review method around that gate.

## 91. `ai-app-privacy-checklist`

### Sources

| Source                                           | Authority                                                  | Published or updated                                                    | Exact URL                                                             |
| ------------------------------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Regulation (EU) 2016/679, Articles 5, 25, and 32 | Official Journal of the European Union, primary legal text | Adopted 27 April 2016; Official Journal 4 May 2016; accessed 2026-07-17 | https://eur-lex.europa.eu/eli/reg/2016/679/art_32/oj/eng              |
| NIST Privacy Framework 1.0                       | NIST official framework, primary                           | January 2020; page updated 22 January 2024; accessed 2026-07-17         | https://www.nist.gov/privacy-framework/privacy-framework              |
| NIST Cybersecurity Framework 2.0                 | NIST final publication, primary                            | 26 February 2024; accessed 2026-07-17                                   | https://www.nist.gov/publications/nist-cybersecurity-framework-csf-20 |

### Claim map

- GDPR Article 5 includes purpose limitation and data minimization; Article 25 addresses data protection by design and default; Article 32 requires risk-appropriate security of processing: official EU text.
- Privacy risk is distinct from cybersecurity risk and can be managed with governance, data-processing awareness, control, communication, and protection activities: NIST Privacy Framework.
- Cybersecurity governance and response outcomes complement privacy work but do not replace privacy analysis: NIST CSF 2.0 and NIST Privacy Framework.

### Drafting cautions

- State that legal duties depend on jurisdiction, role, data, and processing context. Do not present the checklist as legal advice or GDPR compliance proof.
- Hashing or pseudonymization does not automatically make data anonymous.

## 92. `agency-client-app-security-review`

### Sources

| Source                                                     | Authority                       | Published or updated                                       | Exact URL                                                                 |
| ---------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| NIST SP 800-218, Secure Software Development Framework 1.1 | NIST final publication, primary | February 2022; accessed 2026-07-17                         | https://csrc.nist.gov/pubs/sp/800/218/final                               |
| OWASP Application Security Verification Standard 5.0.0     | OWASP official standard         | Version 5.0.0 released 30 May 2025; accessed 2026-07-17    | https://owasp.org/www-project-application-security-verification-standard/ |
| OWASP Software Assurance Maturity Model                    | OWASP official project          | Version 2.0 released 11 February 2020; accessed 2026-07-17 | https://owasp.org/www-project-samm/                                       |

### Claim map

- SSDF provides a common vocabulary for producers, acquirers, and suppliers to communicate secure-development expectations: NIST SP 800-218.
- ASVS can be used to define technical security requirements and verification scope in procurement and delivery: OWASP ASVS.
- SAMM provides an improvement model for governance, design, implementation, verification, and operations rather than a one-time product guarantee: OWASP SAMM.

### Drafting cautions

- Authorization for testing and responsibility for remediation must be explicit and project-specific.
- A prior report is a dated record for its target and scope. It should not be silently reused after material changes.

## 93. `solo-founder-vibe-coding-security`

### Sources

| Source                                                                                              | Authority                                | Published or updated                                           | Exact URL                                                                                                                                               |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NIST Cybersecurity Framework 2.0 Small Business Quick Start Guide                                   | NIST official guide, primary             | 2024; resource page updated 17 April 2026; accessed 2026-07-17 | https://www.nist.gov/itl/smallbusinesscyber/nist-cybersecurity-framework-0                                                                              |
| Shifting the Balance of Cybersecurity Risk: Principles and Approaches for Secure by Design Software | CISA and international partners, primary | October 2023; accessed 2026-07-17                              | https://www.cisa.gov/sites/default/files/2023-10/Shifting-the-Balance-of-Cybersecurity-Risk-Principles-and-Approaches-for-Secure-by-Design-Software.pdf |
| OWASP Application Security Verification Standard 5.0.0                                              | OWASP official standard                  | Version 5.0.0 released 30 May 2025; accessed 2026-07-17        | https://owasp.org/www-project-application-security-verification-standard/                                                                               |

### Claim map

- CSF 2.0 can be adapted by small organizations with modest cybersecurity programs and should be prioritized according to their context: NIST Small Business Quick Start Guide.
- Secure-by-design responsibility should be built into product decisions and defaults instead of shifted to users: CISA guidance.
- ASVS can serve as a technical requirement and verification reference, but founders should choose scope according to risk: OWASP ASVS.

### Drafting cautions

- Do not shame founders for limited staffing or imply one tool replaces expertise.
- Escalation thresholds should be concrete: sensitive or regulated data, payment movement, privileged automation, multi-tenant access, and high availability impact.

## 94. `secure-ai-built-internal-tools`

### Sources

| Source                                                 | Authority                       | Published or updated                                    | Exact URL                                                                                          |
| ------------------------------------------------------ | ------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| NIST SP 800-207, Zero Trust Architecture               | NIST final publication, primary | August 2020; accessed 2026-07-17                        | https://csrc.nist.gov/pubs/sp/800/207/final                                                        |
| OWASP Application Security Verification Standard 5.0.0 | OWASP official standard         | Version 5.0.0 released 30 May 2025; accessed 2026-07-17 | https://owasp.org/www-project-application-security-verification-standard/                          |
| CISA Zero Trust Maturity Model Version 2.0             | CISA official guidance, primary | April 2023; accessed 2026-07-17                         | https://www.cisa.gov/sites/default/files/2023-04/CISA_Zero_Trust_Maturity_Model_Version_2_508c.pdf |

### Claim map

- Network location or asset ownership should not grant implicit trust; authentication and authorization should be evaluated for resources: NIST SP 800-207.
- Internal web applications still need server-enforced authentication, authorization, validation, session, logging, and configuration controls: OWASP ASVS.
- Identity, devices, networks, applications, workloads, and data need coordinated maturity rather than one perimeter control: CISA Zero Trust Maturity Model.

### Drafting cautions

- Do not prescribe a federal zero-trust program to a small internal tool. Translate the principles into managed identity, least privilege, and per-resource authorization.
- "Behind the VPN" and "only employees know the URL" are deployment facts, not complete controls.

## 95. `secure-public-ai-api-endpoints`

### Sources

| Source                                                 | Authority                                           | Published or updated                                    | Exact URL                                                                     |
| ------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| OWASP API Security Top 10 2023                         | OWASP official project standard                     | Stable edition released June 2023; accessed 2026-07-17  | https://owasp.org/API-Security/editions/2023/en/0x00-header/                  |
| Guidelines for Secure AI System Development            | NCSC and international government partners, primary | 27 November 2023; accessed 2026-07-17                   | https://www.ncsc.gov.uk/files/Guidelines-for-secure-AI-system-development.pdf |
| OWASP Application Security Verification Standard 5.0.0 | OWASP official standard                             | Version 5.0.0 released 30 May 2025; accessed 2026-07-17 | https://owasp.org/www-project-application-security-verification-standard/     |

### Claim map

- Public APIs need object and function authorization, authentication, resource controls, inventory, configuration, and safe handling of third-party API data: OWASP API Security Top 10 2023.
- AI components that send data externally or trigger actions should have data controls, input checks, action restrictions, and fail-safes: NCSC guidance.
- Technical verification should cover authentication, access control, validation, API behavior, files, cryptography, logging, and configuration according to scope: OWASP ASVS.

### Drafting cautions

- Do not call an API "secure" because it has an API key or rate limit.
- Model output is untrusted input for downstream code. Avoid publishing operational exploit recipes.

## 96. `app-security-score-explained`

### Sources

| Source                                                 | Authority                        | Published or updated                                    | Exact URL                                                                 |
| ------------------------------------------------------ | -------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| NIST Cybersecurity Framework 2.0                       | NIST final publication, primary  | 26 February 2024; accessed 2026-07-17                   | https://www.nist.gov/publications/nist-cybersecurity-framework-csf-20     |
| OWASP Application Security Verification Standard 5.0.0 | OWASP official standard          | Version 5.0.0 released 30 May 2025; accessed 2026-07-17 | https://owasp.org/www-project-application-security-verification-standard/ |
| CVSS v4.0 Consumer Implementation Guide                | FIRST official standard guidance | Document version 1.0; accessed 2026-07-17               | https://www.first.org/cvss/v4.0/implementation-guide                      |

### Claim map

- CSF 2.0 describes outcomes and organizational Profiles and Tiers; it does not prescribe a universal product score or guarantee: NIST CSF 2.0.
- ASVS verification levels and versioned requirements describe rigor and coverage, not probability of breach: OWASP ASVS.
- CVSS Base metrics describe context-independent severity; consumers should add Threat and Environmental metrics for local decisions: FIRST CVSS guidance.

### Drafting cautions

- LyraShield-specific claims must match `/methodology` and current code. A ScoreSnapshot is a dated aggregate over an explicit methodology, not an accuracy or risk prediction.
- Do not compare scores from different products or scopes without a documented mapping.

## 97. `security-scanner-false-positives`

### Sources

| Source                                                       | Authority                                | Published or updated                      | Exact URL                                                                                                                                  |
| ------------------------------------------------------------ | ---------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| NIST IR 8165, Impact of Code Complexity on Software Analysis | NIST final research publication, primary | February 2017; accessed 2026-07-17        | https://csrc.nist.gov/pubs/ir/8165/final                                                                                                   |
| Static Analysis Results Interchange Format 2.1.0             | OASIS Open standard, primary             | 27 March 2020; accessed 2026-07-17        | https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html                                                                     |
| Resolving code scanning alerts                               | GitHub official documentation            | Living documentation; accessed 2026-07-17 | https://docs.github.com/en/enterprise-cloud@latest/code-security/how-tos/manage-security-alerts/manage-code-scanning-alerts/resolve-alerts |

### Claim map

- Code complexity and analysis limits can make static tools struggle to distinguish weaknesses from safe code: NIST IR 8165.
- SARIF supports explicit baseline states, fingerprints, and suppression records, enabling auditable result management: OASIS SARIF 2.1.0.
- A dismissed alert should have a reviewed reason and optional contextual comment, and false-positive feedback may improve rules: GitHub documentation.

### Drafting cautions

- Reducing displayed alerts is not the same as improving precision. Broad exclusions can increase false negatives.
- Confidence or a second model opinion does not independently verify a finding. Preserve the source, path, preconditions, and retest result.

## 98. `prioritize-security-findings`

### Sources

| Source                                                       | Authority                        | Published or updated                           | Exact URL                                                                        |
| ------------------------------------------------------------ | -------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------- |
| CISA Stakeholder-Specific Vulnerability Categorization Guide | CISA official guidance           | Released 10 November 2022; accessed 2026-07-17 | https://www.cisa.gov/sites/default/files/publications/cisa-ssvc-guide%20508c.pdf |
| Known Exploited Vulnerabilities Catalog                      | CISA official catalog            | Living catalog; accessed 2026-07-17            | https://www.cisa.gov/known-exploited-vulnerabilities-catalog                     |
| CVSS v4.0 Consumer Implementation Guide                      | FIRST official standard guidance | Document version 1.0; accessed 2026-07-17      | https://www.first.org/cvss/v4.0/implementation-guide                             |
| EPSS User Guide                                              | FIRST official model guidance    | Living documentation; accessed 2026-07-17      | https://www.first.org/epss/user-guide                                            |

### Claim map

- SSVC uses exploitation status, technical impact, mission prevalence, and safety or public impact to support action decisions: CISA SSVC.
- KEV identifies vulnerabilities known to have been exploited and is an important threat input when the vulnerable product is actually present: CISA KEV.
- CVSS Base score is system-agnostic severity; Threat and Environmental metrics improve local relevance: FIRST CVSS.
- EPSS estimates the probability of exploitation activity for a published CVE in the next 30 days and is not a complete risk score: FIRST EPSS.

### Drafting cautions

- Do not add CVSS and EPSS numerically or treat either as asset-specific business impact.
- Exposed credentials and active compromise may need containment before a complete backlog score is available.

## 99. `share-security-report-safely`

### Sources

| Source                                                                      | Authority                         | Published or updated                                | Exact URL                                                                                |
| --------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Traffic Light Protocol 2.0                                                  | FIRST official standard, primary  | Authoritative from August 2022; accessed 2026-07-17 | https://www.first.org/tlp/                                                               |
| NIST SP 800-61 Rev. 3, Incident Response Recommendations and Considerations | NIST final publication, primary   | April 2025; accessed 2026-07-17                     | https://csrc.nist.gov/pubs/sp/800/61/r3/final                                            |
| Vulnerability Disclosure Cheat Sheet                                        | OWASP official Cheat Sheet Series | Living guidance; accessed 2026-07-17                | https://cheatsheetseries.owasp.org/cheatsheets/Vulnerability_Disclosure_Cheat_Sheet.html |

### Claim map

- TLP labels communicate permitted sharing boundaries, but TLP is not a licensing, encryption, or access-control system: FIRST TLP 2.0.
- Incident information sharing should be planned within governance, communication, response, and recovery processes: NIST SP 800-61 Rev. 3.
- Vulnerability communication should use defined channels, limit sensitive details to necessary recipients, and support coordinated handling: OWASP Vulnerability Disclosure Cheat Sheet.

### Drafting cautions

- Do not put full secrets, exploit-ready steps, private targets, personal data, or unnecessary architecture details in a public artifact.
- A redacted report must retain scope, date, evidence state, and limitations so the remaining claims are not misleading.

## 100. `exposed-api-key-incident-response`

### Sources

| Source                                                                      | Authority                           | Published or updated                      | Exact URL                                                                               |
| --------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| NIST SP 800-61 Rev. 3, Incident Response Recommendations and Considerations | NIST final publication, primary     | April 2025; accessed 2026-07-17           | https://csrc.nist.gov/pubs/sp/800/61/r3/final                                           |
| Secret scanning                                                             | GitHub official documentation       | Living documentation; accessed 2026-07-17 | https://docs.github.com/en/code-security/concepts/secret-security/secret-scanning       |
| Update access keys                                                          | AWS IAM official documentation      | Living documentation; accessed 2026-07-17 | https://docs.aws.amazon.com/IAM/latest/UserGuide/id-credentials-access-keys-update.html |
| Manage API keys                                                             | Google Cloud official documentation | Updated 2026-07-10; accessed 2026-07-17   | https://docs.cloud.google.com/docs/authentication/api-keys                              |
| API keys                                                                    | Stripe official documentation       | Living documentation; accessed 2026-07-17 | https://docs.stripe.com/keys                                                            |
| Best Practices for API Key Safety                                           | OpenAI official documentation       | Updated 2026-07-14; accessed 2026-07-17   | https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety           |

### Claim map

- Containment, evidence preservation, impact analysis, recovery, and lessons learned belong in one response process: NIST SP 800-61 Rev. 3.
- GitHub recommends immediately rotating an affected credential; rewriting history is secondary after revocation and may be unnecessary for containment: GitHub secret-scanning documentation.
- AWS supports two active IAM user access keys for staged rotation, then deactivation, validation, and deletion of the old key: AWS documentation. This does not apply to every AWS credential type.
- Google Cloud API-key rotation creates a new key with the old restrictions, requires application updates, and then deletes the old key; restrictions can reduce impact: Google Cloud documentation.
- Stripe rotation can revoke immediately or use a provider-supported grace period of up to seven days, and request logs can help confirm migration: Stripe documentation. A compromised key with credible abuse may justify immediate expiry rather than overlap.
- OpenAI instructs users who believe a key leaked to rotate it immediately, update production values, review usage, and contact support when needed: OpenAI documentation.

### Provider-specific recovery matrix

| Provider and credential         | Immediate containment                                                            | Downtime-safe transition                                                                                                                          | Evidence or monitoring note                                                           |
| ------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| AWS IAM user access key         | Deactivate the exposed key if active misuse or impact warrants immediate cut-off | Create the second key, update dependents, check last use, deactivate old, validate, then delete                                                   | `get-access-key-last-used` is useful but does not prove absence of misuse             |
| Google Cloud API key            | Restrict or rotate the key and investigate unexpected usage                      | Rotate to a key with the same intended restrictions, update apps, then delete old                                                                 | Review Cloud Logging and billing or quota anomalies where configured                  |
| Stripe secret or restricted key | Rotate now when compromised; choose immediate expiry for active abuse            | Provider rotation can keep old and new keys valid for a selected grace period up to seven days                                                    | Review per-key request logs and use restricted keys or access policies where possible |
| OpenAI API key                  | Rotate immediately and update affected deployments                               | Create and deploy a replacement before deleting the old key only if the account controls support that sequence and active abuse is not continuing | Review usage and contact support for suspected misuse or charges                      |

### Drafting cautions

- Lead the public article with: restrict or revoke, replace, deploy, verify old denial, review misuse, clean up. Do not lead with Git-history rewriting.
- Never tell readers to print, paste, hash, or submit a live key to a third-party checker. Examples must use unmistakably inert placeholders.
- Provider consoles and policies change. Recheck every vendor step on the publication date and keep provider headings separate.

## Batch-wide research risks and final checks

- Recheck all living vendor pages within 24 hours of publication, especially coding-assistant training and retention controls and API-key rotation behavior.
- Confirm the current CISA KEV URL and availability in the external-link check. The catalog is dynamic, so articles should explain its role rather than quote a count.
- Validate LyraShield-specific score, report, schedule, notification, scan, and retest claims against current code and `/methodology`. Do not infer a public product capability from roadmap language.
- Keep source dates visible in article references. Do not fabricate a publication date for a living documentation page.
- Preserve ASCII hyphens in final prose. Humanizer review must remove em dash and en dash characters, repeated template phrasing, generic conclusions, and manufactured urgency.
