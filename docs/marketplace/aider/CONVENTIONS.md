# LyraShield workflow conventions for Aider

- Use LyraShield only when the user asks for a LyraShield check, scan, evidence review, or retest.
- Ask before running a local staged-diff check when the user has not requested it.
- A recorded scan is paid/authorized work. Confirm workspace and target, then use the least intensive mode that answers the request.
- `lyrashield preflight` is read-only and does not start a scan.
- Preserve `DETECTED`, `INCONCLUSIVE`, `INSUFFICIENT_EVIDENCE`, pending-retest, and cancellation states. Do not infer a verified fix from a patch proposal.
- A fix remains a proposal until trusted retest evidence verifies it. Do not claim certification or universal detection.
- Retain scan IDs and evidence references for resumption. Do not put credentials or raw evidence storage URIs in project files.
