import { describe, expect, it } from "vitest";
import { buildGeocodeQuery, clearGeocodeCache } from "./geocode.js";

describe("buildGeocodeQuery", () => {
  it("combines area, landmark and city", () => {
    expect(buildGeocodeQuery("Sitabuldi market", "bus stop")).toBe("Sitabuldi market, bus stop, Nagpur, India");
  });

  it("drops empty and unidentified locations", () => {
    expect(buildGeocodeQuery("Not identified", "")).toBe("Nagpur, India");
    expect(buildGeocodeQuery(null, undefined, "Pune")).toBe("Pune, India");
  });

  it("clears the cache without throwing", () => {
    clearGeocodeCache();
    expect(buildGeocodeQuery("Sadar")).toContain("Sadar");
  });
});
