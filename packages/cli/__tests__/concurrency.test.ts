import { mapWithConcurrency, normalizeConcurrency } from "../src/client/concurrency.js";

describe("client concurrency helpers", () => {
  it("preserves result order while bounding concurrent work", async () => {
    let active = 0;
    let maxActive = 0;

    const result = await mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value * 10;
    });

    expect(result).toEqual([10, 20, 30, 40]);
    expect(maxActive).toBe(2);
  });

  it("normalizes invalid and excessive concurrency limits", () => {
    expect(normalizeConcurrency(undefined, 2, 4)).toBe(2);
    expect(normalizeConcurrency(0, 2, 4)).toBe(2);
    expect(normalizeConcurrency(10, 2, 4)).toBe(4);
    expect(normalizeConcurrency(2.9, 1, 4)).toBe(2);
  });
});
