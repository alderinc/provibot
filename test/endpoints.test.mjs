import assert from "node:assert/strict";
import test from "node:test";

import { alderMcpUrl, alderServicesUrl, alderUrl } from "../src/endpoints.mjs";

test("ProVIBot uses the fixed public Alder endpoints", () => {
  assert.equal(alderUrl, "https://app.alder.exchange");
  assert.equal(alderMcpUrl, "https://app.alder.exchange/mcp");
  assert.equal(alderServicesUrl, "https://services.alder.exchange");
});
