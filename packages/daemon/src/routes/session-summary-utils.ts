import {
  getSessionMetadataOnly,
  listSessions,
  type SessionLogSummary,
} from "../../sessions/store.js";
import type { RouteEntityCache } from "./entity-cache-types.js";

export function applySessionLiveCounters(
  summaries: SessionLogSummary[],
  entityCache: RouteEntityCache | null | undefined,
): SessionLogSummary[] {
  if (!entityCache) return summaries;
  return summaries.map((summary) => {
    const liveEventCount = entityCache.getSessionLiveEventCount(summary.id);
    if (summary.status === "active" && liveEventCount !== undefined) {
      return { ...summary, event_count: liveEventCount };
    }
    return summary;
  });
}

export async function listSessionSummariesFromDisk(
  sessionsDir: string,
  entityCache?: RouteEntityCache | null,
): Promise<SessionLogSummary[]> {
  const sessionIds = await listSessions(sessionsDir);
  const summaries = await Promise.all(
    sessionIds.map((id) => getSessionMetadataOnly(sessionsDir, id)),
  );
  return applySessionLiveCounters(
    summaries.filter((summary): summary is SessionLogSummary => summary !== null),
    entityCache,
  );
}
