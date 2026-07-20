#!/usr/bin/env node

import { runExtraction } from "../lib/extract.mjs";

const args = parseArgs(process.argv.slice(2));

try {
  const { outputPath, review } = await runExtraction(args);
  process.stderr.write(`candidate extraction: wrote ${review.candidates.length} candidate(s) to ${outputPath}\n`);
} catch (err) {
  process.stderr.write(`candidate extraction failed: ${err.message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input" || arg === "--input-dir") opts.inputDir = requireValue(argv, ++i, arg);
    else if (arg === "--days") opts.days = Number(requireValue(argv, ++i, arg));
    else if (arg === "--since") opts.since = requireValue(argv, ++i, arg);
    else if (arg === "--output" || arg === "-o") opts.output = requireValue(argv, ++i, arg);
    else if (arg === "--min-count") opts.minCount = Number(requireValue(argv, ++i, arg));
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write([
        "Usage: node bin\\extract-candidates.mjs [options]",
        "",
        "Options:",
        "  --input <dir>       Capture log directory (default: copilot-response-log)",
        "  --days <n>          Window in days ending now (default: 7)",
        "  --since <iso-date>  Explicit start timestamp/date",
        "  --output <file>     Candidate review YAML path",
        "  --min-count <n>     Minimum repeated observations per candidate (default: 2)",
        "",
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (opts.days !== undefined && (!Number.isFinite(opts.days) || opts.days <= 0)) {
    throw new Error("--days must be a positive number");
  }
  if (opts.minCount !== undefined && (!Number.isInteger(opts.minCount) || opts.minCount <= 0)) {
    throw new Error("--min-count must be a positive integer");
  }
  return opts;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}
