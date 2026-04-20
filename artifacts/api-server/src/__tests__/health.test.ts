import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../app.js";

describe("Health routes", () => {
  it("GET /api/healthz returns ok", async () => {
    const res = await request(app).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /api/health without auth key returns 401", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });
});
