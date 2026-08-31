import { createHash } from "node:crypto";

const referenceClassMarker = "Full provider health check: $2.45 total against a $0.60 default managed-session window.";

export const durableMemorySeeds = [
  ["/provi/active-work.md", "# Active work\n\nKeep only current owned tasks, their accountable owner, current status, dependencies, and next meaningful action. Remove or mark completed work promptly."],
  ["/provi/decisions.md", "# Decisions\n\nRecord confirmed decisions with date, rationale, and superseded status. Do not preserve unverified proposals."],
  ["/provi/team-context.md", "# Team context\n\nKeep durable project facts, roles, constraints, and cited sources that materially affect future work. Never store credentials or private Slack artifacts."],
  ["/provi/lessons.md", `# Lessons\n\nKeep compact, verified operational lessons and corrections that prevent repeated mistakes. Consolidate duplicates rather than appending a transcript.\n\n## Reference classes\n\n- ${referenceClassMarker} Use this as a planning reference, then replace or refine it with verified receipts for comparable work.`],
];

function listedItems(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function memoryKey(runId, path, content) {
  const digest = createHash("sha256").update(`${path}\n${content}`).digest("hex").slice(0, 16);
  return `provibot:${runId}:memory:${digest}`;
}

/**
 * Add canonical records and one verified reference class without replacing
 * curated agent memory. The content-hash precondition turns a concurrent agent
 * edit into a re-read, never an operator overwrite.
 */
export async function ensureDurableMemoryStructure({ control, state }) {
  if (state.memoryStructureVersion >= 2 && state.lessonsReferenceClassVersion) return state;
  const storeId = encodeURIComponent(state.hosted.memoryStoreId);
  const existing = listedItems(await control("GET", `/memory_stores/${storeId}/memories`, undefined, undefined));
  const byPath = new Map(existing
    .filter((memory) => typeof memory?.path === "string" && typeof memory?.id === "string")
    .map((memory) => [memory.path, memory]));

  for (const [path, content] of durableMemorySeeds) {
    if (byPath.has(path)) continue;
    await control("POST", `/memory_stores/${storeId}/memories`, { path, content }, memoryKey(state.runId, path, content));
  }

  const lessons = byPath.get("/provi/lessons.md");
  if (lessons && !state.lessonsReferenceClassVersion) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await control("GET", `/memory_stores/${storeId}/memories/${encodeURIComponent(lessons.id)}?view=full`, undefined, undefined);
      const content = typeof current?.content === "string" ? current.content : null;
      const contentSha256 = typeof current?.content_sha256 === "string" ? current.content_sha256 : null;
      if (content === null || contentSha256 === null) throw new Error("ProVIBot lessons memory did not return its full content and hash");
      if (content.includes(referenceClassMarker)) break;
      const next = `${content.replace(/\s*$/, "")}\n\n## Reference classes\n\n- ${referenceClassMarker} Use this as a planning reference, then replace or refine it with verified receipts for comparable work.\n`;
      try {
        await control(
          "POST",
          `/memory_stores/${storeId}/memories/${encodeURIComponent(lessons.id)}`,
          { content: next, precondition: { content_sha256: contentSha256, type: "content_sha256" } },
          memoryKey(state.runId, "/provi/lessons.md", next),
        );
        break;
      } catch (error) {
        if (!String(error?.message ?? "").includes("HTTP 409") || attempt === 2) throw error;
      }
    }
  }
  return { ...state, lessonsReferenceClassVersion: 1, memoryStructureVersion: 2 };
}
