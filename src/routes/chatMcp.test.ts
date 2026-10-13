import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import chatMcpRoutes from "./chatMcp.js";

async function withServer(fn: (base: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use("/mcp/chat", chatMcpRoutes);
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test("chat MCP: no key is a JSON-RPC 401, before any database call", () =>
  withServer(async (base) => {
    const res = await fetch(`${base}/mcp/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "ignored" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, -32001);
  }));

test("chat MCP: GET and DELETE are refused on the stateless endpoint", () =>
  withServer(async (base) => {
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(`${base}/mcp/chat`, { method });
      assert.equal(res.status, 405);
    }
  }));
