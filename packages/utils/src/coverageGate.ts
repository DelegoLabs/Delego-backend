/**
 * Test Coverage Enforcement & CI Quality Gates
 * Issue #85
 */

import type {
  CoverageConfig,
  CoverageReport,
  CoverageGateEvaluation,
  MutationTestResult,
} from "@delegolabs/types";

export const DEFAULT_COVERAGE_CONFIG: CoverageConfig = {
  lines: 80,
  functions: 80,
  branches: 70,
  statements: 80,
  excludePaths: ["**/dist/**", "**/node_modules/**", "**/*.test.*"],
  thresholdAutoUpdate: false,
};

export class CoverageGate {
  private config: CoverageConfig;

  constructor(config: Partial<CoverageConfig> = {}) {
    this.config = { ...DEFAULT_COVERAGE_CONFIG, ...config };
  }

  /**
   * Evaluate a coverage report against configured thresholds
   */
  public evaluateCoverage(
    report: CoverageReport,
    mutationResult?: MutationTestResult,
  ): CoverageGateEvaluation {
    const failures: string[] = [];
    const total = report.total;

    const linesPassed = total.lines.pct >= this.config.lines;
    if (!linesPassed) {
      failures.push(
        `Line coverage ${total.lines.pct}% is below required ${this.config.lines}%`,
      );
    }

    const branchesPassed = total.branches.pct >= this.config.branches;
    if (!branchesPassed) {
      failures.push(
        `Branch coverage ${total.branches.pct}% is below required ${this.config.branches}%`,
      );
    }

    const functionsPassed = total.functions.pct >= this.config.functions;
    if (!functionsPassed) {
      failures.push(
        `Function coverage ${total.functions.pct}% is below required ${this.config.functions}%`,
      );
    }

    const statementsPassed = total.statements.pct >= this.config.statements;
    if (!statementsPassed) {
      failures.push(
        `Statement coverage ${total.statements.pct}% is below required ${this.config.statements}%`,
      );
    }

    let mutationPassed = true;
    if (mutationResult) {
      mutationPassed = mutationResult.mutationScore >= 60;
      if (!mutationPassed) {
        failures.push(
          `Mutation score ${mutationResult.mutationScore}% is below required 60%`,
        );
      }
    }

    const passed = failures.length === 0;

    return {
      passed,
      failures,
      summary: {
        lines: {
          current: total.lines.pct,
          required: this.config.lines,
          passed: linesPassed,
        },
        branches: {
          current: total.branches.pct,
          required: this.config.branches,
          passed: branchesPassed,
        },
        functions: {
          current: total.functions.pct,
          required: this.config.functions,
          passed: functionsPassed,
        },
        statements: {
          current: total.statements.pct,
          required: this.config.statements,
          passed: statementsPassed,
        },
        ...(mutationResult
          ? {
              mutationScore: {
                current: mutationResult.mutationScore,
                required: 60,
                passed: mutationPassed,
              },
            }
          : {}),
      },
    };
  }

  /**
   * Generate an SVG Badge for coverage status
   */
  public generateBadgeSvg(metricName: string, pct: number): string {
    const color = pct >= 80 ? "#4c1" : pct >= 70 ? "#dfb317" : "#e05d44";
    return `<svg xmlns="http://www.w3.org/2000/svg" width="104" height="20">
  <linearGradient id="b" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <mask id="a"><rect width="104" height="20" rx="3" fill="#fff"/></mask>
  <g mask="url(#a)">
    <path fill="#555" d="M0 0h62v20H0z"/>
    <path fill="${color}" d="M62 0h42v20H62z"/>
    <path fill="url(#b)" d="M0 0h104v20H0z"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="31" y="15" fill="#010101" fill-opacity=".3">${metricName}</text>
    <text x="31" y="14">${metricName}</text>
    <text x="83" y="15" fill="#010101" fill-opacity=".3">${pct}%</text>
    <text x="83" y="14">${pct}%</text>
  </g>
</svg>`;
  }

  /**
   * Calculate mutation score
   */
  public calculateMutationScore(
    killed: number,
    survived: number,
    timeout: number,
    noCoverage: number,
  ): MutationTestResult {
    const total = killed + survived + timeout + noCoverage;
    const mutationScore = total === 0 ? 100 : Number(((killed / total) * 100).toFixed(2));
    return {
      killed,
      survived,
      timeout,
      noCoverage,
      mutationScore,
    };
  }
}
