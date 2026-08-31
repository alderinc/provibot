import assert from "node:assert/strict";
import test from "node:test";

import { ensureDurableMemoryStructure } from "../src/durable-memory.mjs";

test("renewal seeds the verified cost reference without overwriting existing lessons", async () => {
  const writes = [];
  const state = {
    hosted: { memoryStoreId: "memstore_1" },
    memoryStructureVersion: 1,
    runId: "run_1",
  };
  const control = async (method, path, body) => {
    if (method === "GET" && path.endsWith("/memories")) {
      return { data: [{ id: "mem_lessons", path: "/provi/lessons.md" }] };
    }
    if (method === "GET" && path.endsWith("/memories/mem_lessons?view=full")) {
      return { content: "# Lessons\n\nExisting lesson.", content_sha256: "a".repeat(64) };
    }
    writes.push({ body, method, path });
    return {};
  };

  const updated = await ensureDurableMemoryStructure({ control, state });
  assert.equal(updated.memoryStructureVersion, 2);
  assert.equal(updated.lessonsReferenceClassVersion, 1);
  assert.equal(writes.length, 4);
  const lessonUpdate = writes.find((write) => /\/memories\/mem_lessons$/.test(write.path));
  assert.equal(lessonUpdate?.method, "POST");
  assert.match(lessonUpdate?.body.content, /Existing lesson\./);
  assert.match(lessonUpdate?.body.content, /Full provider health check: \$2\.45 total against a \$0\.60 default managed-session window\./);
  assert.deepEqual(lessonUpdate?.body.precondition, { content_sha256: "a".repeat(64), type: "content_sha256" });
});
