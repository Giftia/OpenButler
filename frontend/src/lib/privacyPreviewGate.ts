export type PreviewTicket = {revision: number; requestId: number};

/** A dismissed session, edit, or newer request can never accept an older result. */
export function createPrivacyPreviewGate() {
  let active = true;
  let revision = 0;
  let requestId = 0;
  return {
    open() { active = true; revision++; },
    close() { active = false; revision++; },
    invalidate() { revision++; },
    request(): PreviewTicket { return {revision, requestId: ++requestId}; },
    isCurrent(ticket: PreviewTicket): boolean {
      return active && ticket.revision === revision && ticket.requestId === requestId;
    },
  };
}
