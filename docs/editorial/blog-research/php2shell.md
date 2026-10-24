# PHP2Shell cluster research

Reviewed 24 October 2026. This source map records the user-approved cluster
extension. Topic selection reflects distinct reader tasks and supplied source
material; it does not assert measured keyword volume or traffic opportunity.

## Coverage and new gaps

Four candidate tasks already have focused articles:

| Reader task                                                                        | Existing article                          |
| ---------------------------------------------------------------------------------- | ----------------------------------------- |
| Identify the serving PHP version and separate CLI output from web-runtime evidence | `check-php-version-php2shell`             |
| Replace Docker, FPM and Apache runtimes and verify workers                         | `patch-php2shell-docker-fpm-apache`       |
| Ask a WordPress host for account-specific patch evidence                           | `php2shell-wordpress-hosting`             |
| Review the separate session upload progress conditions                             | `cve-2026-115560-session-upload-progress` |

`php2shell-explained` remains the overview. The two new articles address separate
uncovered decisions:

- `php2shell-still-flagged-after-updating`: reconcile a scanner's upstream version
  comparison with vendor backport evidence and the actual installed package.
- `php2shell-investigate-earlier-compromise`: determine what incident evidence to
  preserve and review when patching cannot establish that compromise never
  occurred.

The cluster links readers to the free guided PHP2Shell checker and the existing
scan/signup routes. The checker evaluates reported information locally; it does
not establish a vendor package's installed state, validate deployment or perform
incident investigation.

## Primary and supporting source map

| Source                                                                                                                                                                    | Supported use                                                                                                                                                                 | Limits                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [PHP 2026 archive](https://www.php.net/archive/2026.php)                                                                                                                  | Original branch-specific fixed releases and the separate 23 October CVE-2026-115560 configuration notice                                                                      | The original two fixes do not establish a fixed-version threshold for the later notice. A source/version comparison is not deployment proof.                                                                         |
| [CloudLinux PHP status incident](https://cloudlinux.statuspage.io/incidents/zl0vt1yq3dj5)                                                                                 | Vendor explanation that specific earlier-numbered alt-php/ea-php packages already contained backported fixes, with subsequent version alignment and restart/readback guidance | Vendor- and package-specific evidence; never generalize one fixed build to all older-looking PHP packages. Record the complete package revision and serving process evidence.                                        |
| [Red Hat backporting practice](https://access.redhat.com/security/updates/backporting)                                                                                    | Vendor explanation of backporting and why an upstream version string alone can misclassify a vendor package                                                                   | General package-review method, not a PHP2Shell-specific Red Hat patch receipt.                                                                                                                                       |
| [AWS MadPot PHP2Shell analysis](https://aws.amazon.com/blogs/security/amazon-threat-intelligence-identifies-php2shell-exploitation-prior-to-public-disclosure-in-madpot/) | AWS reports a 17 October exploitation attempt in MadPot telemetry before public disclosure, supporting a broader incident review window                                       | AWS says real-world success of the observed attempts was unclear. The observation does not prove a reader's host was compromised; do not convert attempted exploitation into a measured successful-compromise claim. |
| [Erugo issue 293](https://github.com/ErugoOSS/Erugo/issues/293)                                                                                                           | A user-reported example of a container image carrying an older PHP CLI version, illustrating why published images need readback                                               | Community anecdote, not an independent image audit or broad prevalence measurement. Its proposed rebuild and smoke results apply only to the reported setup.                                                         |

Each published article must keep citations beside the claims they support and
re-open time-sensitive vendor information before release. Review vendor backports
against original package evidence; do not suppress deterministic advisory
candidates merely because a user reports a backport. Keep incident response and
credential recovery separate from patch validation.
