// What Anthropic says is wrong, for a session that is only being told "529".
//
// A turn killed by an overload leaves nobody any way to tell whether it is a
// blip or a three-hour incident, so the first instinct is to go and check your
// own quota -- which is never the cause. The status page knows, and the error
// text itself tells you to go there; this fetches the same answer so the panel
// can say it, and so a parked turn can resume the moment the incident closes
// rather than sitting out the rest of its interval.
//
// Deliberately not a gate on retrying. The page is coarser than the failure: an
// incident narrowed to "Opus 4.8 and Opus 5" while the components stayed green,
// and short overloads are never posted at all. Sending the message again is the
// only real test of whether it will go through, and it costs nothing when it
// fails -- so retries run on their own clock and this only ever informs them.

/** The smallest endpoint that answers both questions: 157 bytes when all is well. */
const UNRESOLVED_URL = 'https://status.claude.com/api/v2/incidents/unresolved.json';

const FETCH_TIMEOUT_MS = 5_000;

export interface StatusIncident {
  id: string;
  name: string;
  /** none | minor | major | critical, as the page grades it. */
  impact: string;
  /** ISO 8601, when the incident was first posted. */
  startedAt: string;
}

/**
 * Open incidents, or null when we could not find out.
 *
 * The null is the point of the signature. "No incidents" and "the status page
 * did not answer" are opposite facts, and collapsing them would let an
 * unreachable page read as recovery -- resuming a turn into an outage that is
 * still running, and telling the user it had cleared.
 */
export async function fetchOpenIncidents(
  fetchImpl: typeof fetch = fetch,
): Promise<StatusIncident[] | null> {
  try {
    const res = await fetchImpl(UNRESOLVED_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const incidents = (body as { incidents?: unknown })?.incidents;
    if (!Array.isArray(incidents)) return null;
    return incidents.flatMap((raw) => {
      const i = raw as Record<string, unknown>;
      if (typeof i.id !== 'string' || typeof i.name !== 'string') return [];
      return [
        {
          id: i.id,
          name: i.name,
          impact: typeof i.impact === 'string' ? i.impact : 'unknown',
          startedAt: typeof i.created_at === 'string' ? i.created_at : '',
        },
      ];
    });
  } catch {
    // Unreachable, slow, or not JSON. Never fatal: this is commentary on a
    // retry that is going to happen regardless.
    return null;
  }
}

/** "13:26 UTC" — the part of an ISO instant worth reading in a sentence. */
function clockUtc(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const d = new Date(at);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} UTC`;
}

/**
 * One sentence naming the incident, or null when there is nothing worth saying.
 *
 * Only the worst open incident: during a real outage the page often carries a
 * second, unrelated minor one, and listing both buries the answer.
 */
export function incidentNotice(incidents: StatusIncident[]): string | null {
  const worst = pickWorst(incidents);
  if (!worst) return null;
  const since = clockUtc(worst.startedAt);
  const impact = worst.impact && worst.impact !== 'unknown' ? ` (${worst.impact})` : '';
  return `Anthropic reports: "${worst.name}"${impact}${since ? `, since ${since}` : ''}.`;
}

const IMPACT_ORDER = ['critical', 'major', 'minor', 'none', 'unknown'];

/** The incident a user would care about first. */
export function pickWorst(incidents: StatusIncident[]): StatusIncident | null {
  if (incidents.length === 0) return null;
  return [...incidents].sort(
    (a, b) => IMPACT_ORDER.indexOf(a.impact) - IMPACT_ORDER.indexOf(b.impact),
  )[0];
}
