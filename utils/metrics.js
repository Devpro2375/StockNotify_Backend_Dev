// utils/metrics.js
// Lightweight in-process counters, histograms, and gauges.
// REFACTORED: Auto-starts on import, bounded histogram buffers,
// added reset for counters after summary.

const logger = require("./logger");

const counters = {};   // name -> number (cumulative)
const histograms = {}; // name -> [values] (flushed after summary)
const gauges = {};     // name -> number (point-in-time)
const MAX_HISTOGRAM_SIZE = 10000; // Bound memory usage

let summaryTimer = null;

function inc(name, n = 1) {
  counters[name] = (counters[name] || 0) + n;
}

function observe(name, value) {
  if (!histograms[name]) histograms[name] = [];
  // Prevent unbounded growth
  if (histograms[name].length < MAX_HISTOGRAM_SIZE) {
    histograms[name].push(value);
  }
}

function gauge(name, value) {
  gauges[name] = value;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(idx, 0)];
}

function logSummary() {
  const hasData =
    Object.keys(counters).length ||
    Object.keys(gauges).length ||
    Object.values(histograms).some((v) => v.length > 0);

  if (!hasData) return;

  const summary = { counters: { ...counters }, gauges: { ...gauges } };

  for (const [name, values] of Object.entries(histograms)) {
    if (!values.length) continue;
    summary[name] = {
      count: values.length,
      p50: percentile(values, 50).toFixed(2),
      p95: percentile(values, 95).toFixed(2),
      p99: percentile(values, 99).toFixed(2),
      max: Math.max(...values).toFixed(2),
    };
  }

  logger.info("metrics_summary", summary);

  // Flush histograms + reset counters for next interval
  for (const name of Object.keys(histograms)) {
    histograms[name] = [];
  }
  for (const name of Object.keys(counters)) {
    counters[name] = 0;
  }
}

function start(intervalMs = 60_000) {
  if (summaryTimer) return;
  summaryTimer = setInterval(logSummary, intervalMs);
  summaryTimer.unref();
}

function stop() {
  if (summaryTimer) {
    clearInterval(summaryTimer);
    summaryTimer = null;
  }
}

// Auto-start metrics collection on import
start();

module.exports = { inc, observe, gauge, start, stop };
