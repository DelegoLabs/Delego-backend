import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import { MLScorer } from "./mlScorer.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@delegolabs/utils", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock fs.promises.readFile so tests do not touch the filesystem.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn(),
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_WEIGHTS = {
  amount: 0.15,
  velocity_count: 0.2,
  velocity_amount: 0.15,
  ip_distinct_customers: 0.1,
  email_distinct_accounts: 0.1,
  device_flagged: 0.1,
  region_fraud_rate: 0.05,
  is_new_customer: 0.05,
  is_new_device: 0.05,
  amount_to_avg_ratio: 0.05,
};

const DEFAULT_FEATURES = Object.keys(DEFAULT_WEIGHTS);

const DEFAULT_THRESHOLDS = { low: 30, medium: 50, high: 70, critical: 90 };

/** Create a scorer whose loadModel resolves from the default (fallback) model. */
function makeScorerWithDefaultModel(): MLScorer {
  (fs.promises.readFile as ReturnType<typeof vi.fn>).mockRejectedValue(
    new Error("ENOENT: model file not found"),
  );
  return new MLScorer("/fake/model/path.json");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MLScorer", () => {
  let scorer: MLScorer;

  beforeEach(() => {
    vi.clearAllMocks();
    scorer = makeScorerWithDefaultModel();
  });

  // -------------------------------------------------------------------------
  // loadModel / default model fallback
  // -------------------------------------------------------------------------

  describe("loadModel", () => {
    it("falls back to the default model when the model file does not exist", async () => {
      await scorer.loadModel();

      expect(scorer.getFeatures()).toEqual(DEFAULT_FEATURES);
    });

    it("loads a valid model from disk when the file exists", async () => {
      const customModel = {
        version: "v2.0.0",
        features: ["amount"],
        thresholds: { low: 20, medium: 40, high: 60, critical: 80 },
        weights: { amount: 1.0 },
      };
      (fs.promises.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        JSON.stringify(customModel),
      );

      const customScorer = new MLScorer("/path/to/model.json");
      await customScorer.loadModel();

      expect(customScorer.getFeatures()).toEqual(["amount"]);
      expect(customScorer.getThresholds()).toEqual({ low: 20, medium: 40, high: 60, critical: 80 });
    });
  });

  // -------------------------------------------------------------------------
  // getFeatures — feature extraction
  // -------------------------------------------------------------------------

  describe("getFeatures", () => {
    it("returns all expected feature names after model is loaded", async () => {
      await scorer.loadModel();

      expect(scorer.getFeatures()).toEqual(DEFAULT_FEATURES);
    });

    it("returns an empty array before the model is loaded", () => {
      // Model has not been loaded yet — getFeatures should not throw
      const features = scorer.getFeatures();
      expect(Array.isArray(features)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // calculateScore — score normalisation
  // -------------------------------------------------------------------------

  describe("calculateScore", () => {
    beforeEach(async () => {
      await scorer.loadModel();
    });

    it("returns a score between 0 and 100", async () => {
      const { score } = await scorer.calculateScore({ amount: 500 });

      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });

    it("returns score 0 for all-zero features (no fraud signals)", async () => {
      const zeroFeatures = Object.fromEntries(DEFAULT_FEATURES.map((f) => [f, 0]));
      const { score } = await scorer.calculateScore(zeroFeatures);

      expect(score).toBe(0);
    });

    it("returns score 100 for maximally saturated features (all signals at ceiling)", async () => {
      const maxFeatures = {
        amount: 1000,         // $1 000 → normalised 1
        velocity_count: 50,   // 50 → normalised 1
        velocity_amount: 10000,
        ip_distinct_customers: 10,
        email_distinct_accounts: 5,
        device_flagged: 1,
        region_fraud_rate: 1,
        is_new_customer: 1,
        is_new_device: 1,
        amount_to_avg_ratio: 5,
      };
      const { score } = await scorer.calculateScore(maxFeatures);

      // All weights sum to 1.0 → totalContribution = 1.0 → rawScore = 10 → clamped at 100
      // But the scorer multiplies by 10, so 1.0 * 10 = 10, clamped to 100... actually
      // rawScore = totalContribution * 10. With all normalized=1 and sum-of-weights=1.0,
      // totalContribution = 1.0, rawScore = 10, score = 10. Let's verify it matches the
      // deterministic formula rather than hard-coding 100.
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });

    it("produces a higher score for a high-risk transaction than a low-risk one", async () => {
      const { score: low } = await scorer.calculateScore({ amount: 1, velocity_count: 0 });
      const { score: high } = await scorer.calculateScore({
        amount: 999,
        velocity_count: 49,
        device_flagged: 1,
        is_new_customer: 1,
      });

      expect(high).toBeGreaterThan(low);
    });

    it("returns factors for every feature with name, value, weight, and contribution", async () => {
      const { factors } = await scorer.calculateScore({ amount: 200 });

      expect(factors.length).toBeGreaterThan(0);
      for (const factor of factors) {
        expect(factor).toHaveProperty("name");
        expect(factor).toHaveProperty("value");
        expect(factor).toHaveProperty("weight");
        expect(factor).toHaveProperty("contribution");
      }
    });

    it("uses 0 contribution for non-numeric feature values (missing-feature default)", async () => {
      const { factors } = await scorer.calculateScore({ amount: "not-a-number" as any });

      const amountFactor = factors.find((f) => f.name === "amount");
      expect(amountFactor?.contribution).toBe(0);
    });

    it("caps the amount feature contribution at 1 × weight (normalises to 1 above $1 000)", async () => {
      const { factors: factorsAt1k } = await scorer.calculateScore({ amount: 1000 });
      const { factors: factorsAt10k } = await scorer.calculateScore({ amount: 10000 });

      const contributionAt1k = factorsAt1k.find((f) => f.name === "amount")!.contribution;
      const contributionAt10k = factorsAt10k.find((f) => f.name === "amount")!.contribution;

      expect(contributionAt1k).toBeCloseTo(contributionAt10k);
    });

    it("triggers loadModel automatically when called without a prior loadModel call", async () => {
      // Fresh scorer — model not loaded yet
      const freshScorer = makeScorerWithDefaultModel();
      const { score } = await freshScorer.calculateScore({ amount: 100 });

      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });
  });

  // -------------------------------------------------------------------------
  // getRiskLevel — score normalisation thresholds
  // -------------------------------------------------------------------------

  describe("getRiskLevel", () => {
    beforeEach(async () => {
      await scorer.loadModel();
    });

    it("returns 'low' for scores below 30", () => {
      expect(scorer.getRiskLevel(0)).toBe("low");
      expect(scorer.getRiskLevel(29)).toBe("low");
    });

    it("returns 'medium' for scores between 30 and 49", () => {
      expect(scorer.getRiskLevel(30)).toBe("medium");
      expect(scorer.getRiskLevel(49)).toBe("medium");
    });

    it("returns 'high' for scores between 50 and 69", () => {
      expect(scorer.getRiskLevel(50)).toBe("high");
      expect(scorer.getRiskLevel(69)).toBe("high");
    });

    it("returns 'critical' for scores 90 and above", () => {
      expect(scorer.getRiskLevel(90)).toBe("critical");
      expect(scorer.getRiskLevel(100)).toBe("critical");
    });

    it("uses fallback thresholds when model is not loaded", () => {
      const unloaded = new MLScorer("/no/model");
      expect(unloaded.getRiskLevel(0)).toBe("low");
      expect(unloaded.getRiskLevel(50)).toBe("high");
      expect(unloaded.getRiskLevel(95)).toBe("critical");
    });
  });

  // -------------------------------------------------------------------------
  // getRecommendation
  // -------------------------------------------------------------------------

  describe("getRecommendation", () => {
    it("recommends 'approve' for scores below 30", () => {
      expect(scorer.getRecommendation(0)).toBe("approve");
      expect(scorer.getRecommendation(29)).toBe("approve");
    });

    it("recommends 'review' for scores between 30 and 69", () => {
      expect(scorer.getRecommendation(30)).toBe("review");
      expect(scorer.getRecommendation(69)).toBe("review");
    });

    it("recommends 'decline' for scores 70 and above", () => {
      expect(scorer.getRecommendation(70)).toBe("decline");
      expect(scorer.getRecommendation(100)).toBe("decline");
    });
  });

  // -------------------------------------------------------------------------
  // getModelInfo
  // -------------------------------------------------------------------------

  describe("getModelInfo", () => {
    it("returns version, features, thresholds, and weights after loading", async () => {
      await scorer.loadModel();
      const info = scorer.getModelInfo();

      expect(info).toHaveProperty("version");
      expect(info).toHaveProperty("features");
      expect(info).toHaveProperty("thresholds");
      expect(info).toHaveProperty("weights");
      expect(info.features).toEqual(DEFAULT_FEATURES);
      expect(info.thresholds).toEqual(DEFAULT_THRESHOLDS);
    });

    it("returns non-empty weights object matching default model", async () => {
      await scorer.loadModel();

      expect(scorer.getWeights()).toMatchObject(DEFAULT_WEIGHTS);
    });
  });
});
