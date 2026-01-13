import * as fs from "fs";
import * as path from "path";
import type { BenchmarkResult, GlobalScore, MetricComparison, ScoreCategory, DatabaseType } from "./types.js";
import { formatBytes, formatMs, formatSeconds } from "./measure.js";

/**
 * Calculate global score comparing LeanGraph to competitors
 */
export function calculateGlobalScore(results: BenchmarkResult): GlobalScore | null {
  const leangraph = results.databases.find((d) => d.database === "leangraph");
  if (!leangraph) return null;

  const competitors = results.databases.filter((d) => d.database !== "leangraph");
  if (competitors.length === 0) return null;

  const comparisons: MetricComparison[] = [];

  // Helper to add a metric comparison
  const addMetric = (
    metric: string,
    lgValue: number,
    getCompetitorValue: (db: typeof competitors[0]) => number,
    lowerIsBetter: boolean,
    isTimeMetric: boolean // true for latency/time, false for size/memory
  ) => {
    if (lgValue <= 0) return;

    const comparisonResults: MetricComparison["comparisons"] = [];
    let dominated = true; // LG better than all competitors (>2x)
    let competitive = false; // At least one competitive (0.5x-2x)
    let anyTradeoff = false; // LG worse than any competitor (>2x)

    // Words to use based on metric type
    const betterWord = isTimeMetric ? "faster" : "less";
    const worseWord = isTimeMetric ? "slower" : "more";

    for (const comp of competitors) {
      const compValue = getCompetitorValue(comp);
      if (compValue <= 0) continue;

      // Calculate ratio: >1 means LeanGraph is better
      const ratio = lowerIsBetter ? compValue / lgValue : lgValue / compValue;
      
      let formatted: string;
      if (ratio >= 1) {
        formatted = ratio >= 10 
          ? `${Math.round(ratio)}x ${betterWord}`
          : `${ratio.toFixed(1)}x ${betterWord}`;
      } else {
        const inverse = 1 / ratio;
        formatted = inverse >= 10
          ? `${Math.round(inverse)}x ${worseWord}`
          : `${inverse.toFixed(1)}x ${worseWord}`;
      }

      comparisonResults.push({
        database: comp.database,
        value: compValue,
        ratio,
        formatted,
      });

      if (ratio < 2) dominated = false;
      if (ratio >= 0.5 && ratio < 2) competitive = true;
      if (ratio < 0.5) anyTradeoff = true;
    }

    if (comparisonResults.length === 0) return;

    // Determine category based on worst case
    let category: ScoreCategory;
    if (anyTradeoff) {
      category = "tradeoff";
    } else if (dominated) {
      category = "advantage";
    } else {
      category = "competitive";
    }

    comparisons.push({
      metric,
      category,
      leangraphValue: lgValue,
      comparisons: comparisonResults,
    });
  };

  // Resource metrics
  addMetric(
    "Load time",
    leangraph.load.timeSeconds,
    (c) => c.load.timeSeconds,
    true,  // lowerIsBetter
    true   // isTimeMetric
  );

  addMetric(
    "Cold start",
    leangraph.coldStartMs,
    (c) => c.coldStartMs,
    true,  // lowerIsBetter
    true   // isTimeMetric
  );

  addMetric(
    "RAM usage",
    leangraph.afterQueries.ramBytes,
    (c) => c.afterQueries.ramBytes,
    true,  // lowerIsBetter
    false  // isTimeMetric (it's a size metric)
  );

  addMetric(
    "Disk usage",
    leangraph.afterQueries.diskBytes,
    (c) => c.afterQueries.diskBytes,
    true,  // lowerIsBetter
    false  // isTimeMetric (it's a size metric)
  );

  // Query metrics by category
  const categories = ["lookup", "pattern", "aggregation", "traversal", "write"] as const;
  
  for (const cat of categories) {
    const lgQueries = leangraph.queries.filter((q) => q.category === cat);
    if (lgQueries.length === 0) continue;
    
    const lgAvg = lgQueries.reduce((sum, q) => sum + q.timing.p50, 0) / lgQueries.length;
    
    addMetric(
      `${cat.charAt(0).toUpperCase() + cat.slice(1)} queries`,
      lgAvg,
      (c) => {
        const cQueries = c.queries.filter((q) => q.category === cat);
        if (cQueries.length === 0) return 0;
        return cQueries.reduce((sum, q) => sum + q.timing.p50, 0) / cQueries.length;
      },
      true,  // lowerIsBetter
      true   // isTimeMetric
    );
  }

  // Sort into categories
  const advantages = comparisons.filter((c) => c.category === "advantage");
  const competitive = comparisons.filter((c) => c.category === "competitive");
  const tradeoffs = comparisons.filter((c) => c.category === "tradeoff");

  return {
    advantages,
    competitive,
    tradeoffs,
    summary: {
      wins: advantages.length,
      competitive: competitive.length,
      tradeoffs: tradeoffs.length,
      total: comparisons.length,
    },
  };
}

/**
 * Format global score for text output (CLI/Markdown)
 */
export function formatGlobalScoreText(score: GlobalScore): string {
  const lines: string[] = [];

  // Merge advantages and competitive into "LeanGraph Strengths"
  const strengths = [...score.advantages, ...score.competitive];
  if (strengths.length > 0) {
    lines.push("✓ LeanGraph Strengths:");
    for (const m of strengths) {
      const comps = m.comparisons.map((c) => {
        if (c.ratio >= 0.9 && c.ratio <= 1.1) return `similar to ${c.database}`;
        return `${c.formatted} than ${c.database}`;
      }).join(", ");
      lines.push(`  • ${m.metric}: ${comps}`);
    }
    lines.push("");
  }

  if (score.tradeoffs.length > 0) {
    lines.push("○ Native Graph Territory:");
    for (const m of score.tradeoffs) {
      const comps = m.comparisons.map((c) => `${c.formatted} than ${c.database}`).join(", ");
      lines.push(`  • ${m.metric}: ${comps}`);
    }
    lines.push("");
  }

  const strengthCount = score.summary.wins + score.summary.competitive;
  lines.push(`Overall: ${strengthCount}/${score.summary.total} metrics ahead or competitive`);

  return lines.join("\n");
}

/**
 * Generate Markdown report
 */
export function generateMarkdown(results: BenchmarkResult): string {
  const lines: string[] = [];

  lines.push("# LeanGraph Benchmark Results");
  lines.push("");
  lines.push(`**Date:** ${new Date(results.timestamp).toLocaleString()}`);
  lines.push(`**Scale:** ${results.scale} (${results.totalNodes.toLocaleString()} nodes, ${results.totalEdges.toLocaleString()} edges)`);
  lines.push("");

  // Summary table
  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | " + results.databases.map((d) => d.database).join(" | ") + " |");
  lines.push("|--------|" + results.databases.map(() => "--------").join("|") + "|");

  lines.push("| Version | " + results.databases.map((d) => d.version).join(" | ") + " |");
  lines.push("| **Total Duration** | " + results.databases.map((d) => `**${formatSeconds(d.totalDurationSeconds)}**`).join(" | ") + " |");
  lines.push("| Load Time | " + results.databases.map((d) => formatSeconds(d.load.timeSeconds)).join(" | ") + " |");
  lines.push("| Disk (before) | " + results.databases.map((d) => formatBytes(d.beforeQueries.diskBytes)).join(" | ") + " |");
  lines.push("| Disk (after) | " + results.databases.map((d) => formatBytes(d.afterQueries.diskBytes)).join(" | ") + " |");
  lines.push("| RAM (before) | " + results.databases.map((d) => formatBytes(d.beforeQueries.ramBytes)).join(" | ") + " |");
  lines.push("| RAM (after) | " + results.databases.map((d) => formatBytes(d.afterQueries.ramBytes)).join(" | ") + " |");
  lines.push("| Cold Start | " + results.databases.map((d) => formatMs(d.coldStartMs)).join(" | ") + " |");
  lines.push("");

  // Global Score section
  const score = calculateGlobalScore(results);
  if (score) {
    lines.push("## LeanGraph Score");
    lines.push("");
    lines.push(formatGlobalScoreText(score));
    lines.push("");
  }

  // Query performance by category
  const categories = ["lookup", "pattern", "aggregation", "traversal", "write"];
  for (const cat of categories) {
    lines.push(`## ${cat.charAt(0).toUpperCase() + cat.slice(1)} Queries`);
    lines.push("");

    // Find queries in this category
    const queryNames = new Set<string>();
    for (const db of results.databases) {
      for (const q of db.queries) {
        if (q.category === cat) queryNames.add(q.name);
      }
    }

    if (queryNames.size === 0) continue;

    lines.push("| Query | " + results.databases.map((d) => `${d.database} p50`).join(" | ") + " | " + results.databases.map((d) => `${d.database} p95`).join(" | ") + " |");
    lines.push("|-------|" + results.databases.map(() => "--------").join("|") + "|" + results.databases.map(() => "--------").join("|") + "|");

    for (const qName of queryNames) {
      const p50s = results.databases.map((d) => {
        const q = d.queries.find((q) => q.name === qName);
        return q ? formatMs(q.timing.p50) : "N/A";
      });
      const p95s = results.databases.map((d) => {
        const q = d.queries.find((q) => q.name === qName);
        return q ? formatMs(q.timing.p95) : "N/A";
      });
      lines.push(`| ${qName} | ${p50s.join(" | ")} | ${p95s.join(" | ")} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Generate HTML report
 */
export function generateHtml(results: BenchmarkResult): string {
  // Find best values for highlighting (use afterQueries for final state)
  const bestDiskBefore = Math.min(...results.databases.map((d) => d.beforeQueries.diskBytes || Infinity));
  const bestDiskAfter = Math.min(...results.databases.map((d) => d.afterQueries.diskBytes || Infinity));
  const bestRamBefore = Math.min(...results.databases.map((d) => d.beforeQueries.ramBytes || Infinity));
  const bestRamAfter = Math.min(...results.databases.map((d) => d.afterQueries.ramBytes || Infinity));

  let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>LeanGraph Benchmark Results</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 1200px; margin: 0 auto; padding: 2rem; background: #0d1117; color: #e6edf3; }
    h1, h2 { color: #58a6ff; }
    table { width: 100%; border-collapse: collapse; margin: 1rem 0; background: #161b22; border-radius: 8px; overflow: hidden; }
    th, td { padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid #30363d; }
    th { background: #21262d; color: #8b949e; font-weight: 600; }
    tr:last-child td { border-bottom: none; }
    .best { color: #3fb950; font-weight: 600; }
    .metric { color: #8b949e; }
    code { background: #21262d; padding: 0.2rem 0.4rem; border-radius: 4px; font-size: 0.9em; }
    .score-section { background: #161b22; border-radius: 8px; padding: 1.5rem; margin: 1.5rem 0; }
    .score-category { margin-bottom: 1rem; }
    .score-category h3 { margin: 0 0 0.5rem 0; font-size: 1rem; }
    .score-category.strengths h3 { color: #3fb950; }
    .score-category.native h3 { color: #8b949e; }
    .score-item { margin: 0.25rem 0 0.25rem 1rem; color: #8b949e; }
    .score-summary { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid #30363d; font-weight: 600; }
  </style>
</head>
<body>
  <h1>LeanGraph Benchmark Results</h1>
  <p><strong>Date:</strong> ${new Date(results.timestamp).toLocaleString()}</p>
  <p><strong>Scale:</strong> ${results.scale} (${results.totalNodes.toLocaleString()} nodes, ${results.totalEdges.toLocaleString()} edges)</p>

  <h2>Summary</h2>
  <table>
    <thead>
      <tr>
        <th>Metric</th>
        ${results.databases.map((d) => `<th>${d.database}</th>`).join("\n        ")}
      </tr>
    </thead>
    <tbody>
      <tr>
        <td class="metric">Version</td>
        ${results.databases.map((d) => `<td>${d.version}</td>`).join("\n        ")}
      </tr>
      <tr>
        <td class="metric"><strong>Total Duration</strong></td>
        ${results.databases.map((d) => `<td><strong>${formatSeconds(d.totalDurationSeconds)}</strong></td>`).join("\n        ")}
      </tr>
      <tr>
        <td class="metric">Load Time</td>
        ${results.databases.map((d) => `<td>${formatSeconds(d.load.timeSeconds)}</td>`).join("\n        ")}
      </tr>
      <tr>
        <td class="metric">Disk (before)</td>
        ${results.databases.map((d) => `<td${d.beforeQueries.diskBytes === bestDiskBefore ? ' class="best"' : ''}>${formatBytes(d.beforeQueries.diskBytes)}</td>`).join("\n        ")}
      </tr>
      <tr>
        <td class="metric">Disk (after)</td>
        ${results.databases.map((d) => `<td${d.afterQueries.diskBytes === bestDiskAfter ? ' class="best"' : ''}>${formatBytes(d.afterQueries.diskBytes)}</td>`).join("\n        ")}
      </tr>
      <tr>
        <td class="metric">RAM (before)</td>
        ${results.databases.map((d) => `<td${d.beforeQueries.ramBytes === bestRamBefore ? ' class="best"' : ''}>${formatBytes(d.beforeQueries.ramBytes)}</td>`).join("\n        ")}
      </tr>
      <tr>
        <td class="metric">RAM (after)</td>
        ${results.databases.map((d) => `<td${d.afterQueries.ramBytes === bestRamAfter ? ' class="best"' : ''}>${formatBytes(d.afterQueries.ramBytes)}</td>`).join("\n        ")}
      </tr>
      <tr>
        <td class="metric">Cold Start</td>
        ${results.databases.map((d) => `<td>${formatMs(d.coldStartMs)}</td>`).join("\n        ")}
      </tr>
    </tbody>
  </table>
`;

  // Global Score section
  const score = calculateGlobalScore(results);
  if (score) {
    html += `
  <h2>LeanGraph Score</h2>
  <div class="score-section">`;

    // Helper to format comparison with bold for positive results
    const formatHtmlComparison = (c: typeof score.advantages[0]["comparisons"][0]) => {
      let text: string;
      if (c.ratio >= 0.9 && c.ratio <= 1.1) {
        text = `similar to ${c.database}`;
      } else {
        text = `${c.formatted} than ${c.database}`;
      }
      // Bold if positive (ratio >= 1 means LeanGraph is better)
      return c.ratio >= 1 ? `<strong>${text}</strong>` : text;
    };

    // Merge advantages and competitive into "LeanGraph Strengths"
    const strengths = [...score.advantages, ...score.competitive];
    if (strengths.length > 0) {
      html += `
    <div class="score-category strengths">
      <h3>✓ LeanGraph Strengths</h3>`;
      for (const m of strengths) {
        const comps = m.comparisons.map(formatHtmlComparison).join(", ");
        html += `
      <div class="score-item">• ${m.metric}: ${comps}</div>`;
      }
      html += `
    </div>`;
    }

    if (score.tradeoffs.length > 0) {
      html += `
    <div class="score-category native">
      <h3>○ Native Graph Territory</h3>`;
      for (const m of score.tradeoffs) {
        const comps = m.comparisons.map(formatHtmlComparison).join(", ");
        html += `
      <div class="score-item">• ${m.metric}: ${comps}</div>`;
      }
      html += `
    </div>`;
    }

    const strengthCount = score.summary.wins + score.summary.competitive;
    html += `
    <div class="score-summary">
      Overall: ${strengthCount}/${score.summary.total} metrics ahead or competitive
    </div>
  </div>
`;
  }

  // Query tables by category
  const categories = ["lookup", "pattern", "aggregation", "traversal", "write"];
  for (const cat of categories) {
    const queryNames = new Set<string>();
    for (const db of results.databases) {
      for (const q of db.queries) {
        if (q.category === cat) queryNames.add(q.name);
      }
    }
    if (queryNames.size === 0) continue;

    html += `
  <h2>${cat.charAt(0).toUpperCase() + cat.slice(1)} Queries</h2>
  <table>
    <thead>
      <tr>
        <th>Query</th>
        ${results.databases.map((d) => `<th>${d.database} p50</th>`).join("\n        ")}
        ${results.databases.map((d) => `<th>${d.database} p95</th>`).join("\n        ")}
      </tr>
    </thead>
    <tbody>`;

    for (const qName of queryNames) {
      const p50Values = results.databases.map((d) => {
        const q = d.queries.find((q) => q.name === qName);
        return q?.timing.p50 ?? Infinity;
      });
      const bestP50 = Math.min(...p50Values);

      html += `
      <tr>
        <td><code>${qName}</code></td>`;

      for (let i = 0; i < results.databases.length; i++) {
        const q = results.databases[i].queries.find((q) => q.name === qName);
        const isBest = p50Values[i] === bestP50;
        html += `
        <td${isBest ? ' class="best"' : ''}>${q ? formatMs(q.timing.p50) : "N/A"}</td>`;
      }
      for (let i = 0; i < results.databases.length; i++) {
        const q = results.databases[i].queries.find((q) => q.name === qName);
        html += `
        <td>${q ? formatMs(q.timing.p95) : "N/A"}</td>`;
      }
      html += `
      </tr>`;
    }

    html += `
    </tbody>
  </table>`;
  }

  html += `
</body>
</html>`;

  return html;
}

/**
 * Generate landing page HTML snippet
 */
export function generateSnippet(results: BenchmarkResult): string {
  // Find best values (use afterQueries for final state)
  const findBest = (getter: (d: typeof results.databases[0]) => number) => {
    let best = Infinity;
    let bestDb = "";
    for (const d of results.databases) {
      const val = getter(d);
      if (val > 0 && val < best) {
        best = val;
        bestDb = d.database;
      }
    }
    return bestDb;
  };

  const bestDisk = findBest((d) => d.afterQueries.diskBytes);
  const bestRam = findBest((d) => d.afterQueries.ramBytes);

  // Get average p50 for lookups
  const getAvgLookupP50 = (db: typeof results.databases[0]) => {
    const lookups = db.queries.filter((q) => q.category === "lookup");
    if (lookups.length === 0) return 0;
    return lookups.reduce((sum, q) => sum + q.timing.p50, 0) / lookups.length;
  };
  const bestLookup = findBest((d) => getAvgLookupP50(d) || Infinity);

  // Generate score summary for snippet
  const score = calculateGlobalScore(results);
  let scoreComment = "";
  if (score) {
    scoreComment = `<!-- Score: Wins ${score.summary.wins}/${score.summary.total} | Competitive ${score.summary.competitive}/${score.summary.total} | Trade-offs ${score.summary.tradeoffs}/${score.summary.total} -->
`;
  }

  const html = `<!-- Auto-generated by benchmark - ${new Date().toISOString()} -->
<!-- Scale: ${results.scale} (${results.totalNodes.toLocaleString()} nodes, ${results.totalEdges.toLocaleString()} edges) -->
${scoreComment}<table>
  <thead>
    <tr>
      <th>Metric</th>
${results.databases.map((d) => `      <th>${d.database.charAt(0).toUpperCase() + d.database.slice(1)}</th>`).join("\n")}
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Disk Usage (${results.scale})</td>
${results.databases.map((d) => `      <td${d.database === bestDisk ? ' class="check"' : ''}>${formatBytes(d.afterQueries.diskBytes)}</td>`).join("\n")}
    </tr>
    <tr>
      <td>RAM Usage</td>
${results.databases.map((d) => `      <td${d.database === bestRam ? ' class="check"' : ''}>${formatBytes(d.afterQueries.ramBytes)}</td>`).join("\n")}
    </tr>
    <tr>
      <td>Lookup Query p50</td>
${results.databases.map((d) => {
  const avg = getAvgLookupP50(d);
  return `      <td${d.database === bestLookup ? ' class="check"' : ''}>${avg > 0 ? formatMs(avg) : "N/A"}</td>`;
}).join("\n")}
    </tr>
    <tr>
      <td>Cold Start</td>
${results.databases.map((d) => `      <td>${formatMs(d.coldStartMs)}</td>`).join("\n")}
    </tr>
  </tbody>
</table>`;

  return html;
}

/**
 * Write all reports to disk
 */
export function writeReports(
  results: BenchmarkResult,
  outputPrefix: string,
  options: { json?: boolean; markdown?: boolean; html?: boolean; snippet?: boolean } = {}
): string[] {
  const { json = true, markdown = true, html = true, snippet = true } = options;
  const written: string[] = [];

  const dir = path.dirname(outputPrefix);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (json) {
    const jsonPath = `${outputPrefix}.json`;
    fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
    written.push(jsonPath);
  }

  if (markdown) {
    const mdPath = `${outputPrefix}.md`;
    fs.writeFileSync(mdPath, generateMarkdown(results));
    written.push(mdPath);
  }

  if (html) {
    const htmlPath = `${outputPrefix}.html`;
    fs.writeFileSync(htmlPath, generateHtml(results));
    written.push(htmlPath);
  }

  if (snippet) {
    const snippetPath = `${outputPrefix}-snippet.html`;
    fs.writeFileSync(snippetPath, generateSnippet(results));
    written.push(snippetPath);
  }

  return written;
}

/**
 * Generate timestamp string for filenames: YYYYMMDDHHmm
 */
export function formatTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`;
}
