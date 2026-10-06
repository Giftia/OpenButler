# Instance-owned backend lifecycle

The desktop runtime starts no global cleanup and never terminates backends by executable name. Each instance may stop only the live ChildProcess it spawned. A cached status PID is not authority to terminate a process.

## Stop and revocation

On Windows, the packaged PyInstaller one-file backend includes a launcher and Python descendant. Stopping only the launcher is insufficient. The runtime requests termination of its retained live child PID and that child's process tree, then requires both successful tree termination and an observed owned-child exit. Other same-channel, Trial, or stable instances are outside this stop. On non-Windows source runtimes, termination uses the owned child handle.

Normal restart and quit retain the existing capture-pause acknowledgment ordering. Pending temporary-model validation and explicit revocation stop the owned backend immediately. A failed tree command or unobserved child exit keeps the stop guard active, blocks replacement startup, and reports an unconfirmed stop. A normal quit cannot report success in that state. Unknown old or orphan processes are never adopted or killed automatically.

An encrypted configuration-save failure can leave new routes active in backend memory even after the temporary-route marker is cleared. Revocation therefore also covers uncertain persistence. A late save response from a stopped backend generation cannot persist or reactivate its configuration. Stored files are not deleted by session revocation.

## Build identity

Preview and Windows Trial installer versions advance within their respective artifact-name namespaces. A requested version whose installer already exists fails before building instead of overwriting that artifact. This does not install either channel or authorize release publication.

## Verification boundary

The fully mocked `desktop/scripts/check-local-session-main.cjs` exercises instance isolation, owned-tree termination, failed and late stops, pause ordering, pending model cancellation, failed-save revocation, and independent build sequences. It invokes no real process termination, model, capture, or installer. Native unpacked acceptance and a check for owned-process residue remain required separately; these tests do not certify installer lifecycle behavior. The older controller and installer scripts retain separate authority and must not be used as source-only merge or status probes.
