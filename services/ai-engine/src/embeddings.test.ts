import { describe, expect, it } from "vitest";
import { EMBED_DIMS, buildEmbedRequest, toVectorLiteral } from "./embeddings.js";

describe("buildEmbedRequest", () => {
  it("pins the model, dims and truncation", () => {
    const req = buildEmbedRequest("a".repeat(9000));
    expect(req.model).toBe("models/gemini-embedding-001");
    expect(req.outputDimensionality).toBe(1536);
    expect(req.text).toHaveLength(8000);
  });
});

describe("toVectorLiteral", () => {
  it("formats exactly 1536 finite dims", () => {
    const lit = toVectorLiteral(new Array(EMBED_DIMS).fill(0.1));
    expect(lit?.startsWith("[0.1,0.1")).toBe(true);
    expect(lit?.endsWith("]")).toBe(true);
  });

  it("rejects wrong length and non-finite values", () => {
    expect(toVectorLiteral(new Array(768).fill(0))).toBeNull();
    expect(toVectorLiteral("nope")).toBeNull();
    const bad = new Array(EMBED_DIMS).fill(0);
    bad[7] = Number.NaN;
    expect(toVectorLiteral(bad)).toBeNull();
  });
});
