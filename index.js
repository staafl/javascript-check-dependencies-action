const core = require("@actions/core");
const glob = require("@actions/glob");
const fs = require("fs");
const semver = require("semver");

function isInGitHubAction() {
    return process.env.GITHUB_RUN_ID && process.env.CI;
}

let exitCode = 0;

function setFailed(msg) {
    if (isInGitHubAction()) {
        core.setFailed(msg);
    } else {
        console.error(msg)
        exitCode = 1;
    }
}


function error(msg) {
    if (isInGitHubAction()) {
        core.error(msg);
    } else {
        console.error(msg)
    }
}

function warn(msg) {
    if (isInGitHubAction()) {
        core.warning(msg);
    } else {
        console.warn(msg)
    }
}

function info(msg) {
    if (isInGitHubAction()) {
        core.info(msg);
    } else {
        console.info(msg)
    }
}

function startGroup(msg) {
    if (isInGitHubAction()) {
        core.startGroup(msg);
    } else {
        console.info("===============")
        console.info(msg)
        console.info("===============")
    }
}

function endGroup() {
    if (isInGitHubAction()) {
        core.endGroup();
    } else {
        console.info("===============")
    }
}

function getInput(name, opts) {
    if (isInGitHubAction()) {
        return core.getInput(name, opts);
    } else {
        if (name === "rules_url") {
            return process.env.JAVASCRIPT_CHECK_DEPENDENCIES_RULES_URL ??
                "https://raw.githubusercontent.com/interopio/javascript-check-dependencies-action/refs/heads/master/bad-deps.json";
        }
        throw new Error(`Unknown input name: ${name}`);
    }
}

async function run() {
  try {
    const rulesUrl = getInput("rules_url", { required: true });

    // badRules structure after loading:
    // {
    //   "@acme/bad": ["1.0.*", "^1.1.2"],
    //   "evil-package": ["*"]
    // }
    const badRules = await loadBadDependencyRules(rulesUrl);

    if (!badRules || Object.keys(badRules).length === 0) {
      warn("No bad dependency rules loaded – nothing to check.");
      return;
    }

    const globber = await glob.create("**/package-lock.json");
    const files = [];
    for await (const file of globber.globGenerator()) {
      files.push(file);
    }

    if (files.length === 0) {
      info("No package-lock.json files found. Nothing to check.");
      return;
    }

    info(`Found ${files.length} package-lock.json file(s). Scanning...`);

    const allFindings = [];

    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      let json;

      try {
        json = JSON.parse(content);
      } catch (err) {
        warn(`Skipping ${file}: invalid JSON (${err.message})`);
        continue;
      }

      const findings = scanPackageLock(json, file, badRules);
      allFindings.push(...findings);
    }

    if (allFindings.length > 0) {
      startGroup("Compromised dependencies found");
      for (const finding of allFindings) {
        error(
          `File: ${finding.file}\n` +
          `Location: ${finding.location}\n` +
          `Package: ${finding.name}\n` +
          `Version: ${finding.version}\n` +
          `Matched ranges: ${finding.matchedRanges.join(", ")}\n`
        );
      }
      endGroup();
      setFailed(
        `Detected ${allFindings.length} occurrence(s) of dependencies matching the bad rules from ${rulesUrl}.`
      );
    } else {
      info(`No compromised dependencies found using rules from ${rulesUrl}.`);
    }
  } catch (error) {
    setFailed(error.message);
  }
}

/**
 * Load bad dependency rules from a URL.
 * Expected format:
 * [
 *   ["@acme/bad", "1.0.*", "^1.1.2"],
 *   ["evil-package": "*"]
 * ]
 */
async function loadBadDependencyRules(url) {
  info(`Loading bad dependency rules from ${url}...`);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch bad dependency rules: ${res.status} ${res.statusText}`);
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error(`Bad dependency rules at ${url} are not valid JSON: ${e.message}`);
  }

  if (!data || !Array.isArray(data)) {
    throw new Error("Bad dependency rules: JSON must be an array with each entry of the format [package-name,range1,range2...].");
  }

  const normalized = {};

  for (const pkgAndRanges of data) {
    // ["@acme/bad", "1.0.*", "^1.1.2"]
    if (Array.isArray(pkgAndRanges)) {
      const name = pkgAndRanges[0];
      if (!normalized[name]) {
        normalized[name] = [];
      }
      [].push.apply(normalized[name], pkgAndRanges.slice(1).map(String));
    } else {
      warn(
        `Ignoring rules for "${pkg}" – array of strings, got ${typeof pkgAndRanges}`
      );
    }
  }

  info(
    `Loaded rules for ${Object.keys(normalized).length} package(s): ${Object.keys(normalized).slice(0, 3).join(",")}...`
  );

  return normalized;
}

/**
 * Check if a given (packageName, version) is bad according to rules.
 *
 * rules = {
 *   "@acme/bad": ["1.0.*", "^1.1.2"],
 *   "evil-package": ["*"]
 * }
 */
function matchBadRules(packageName, version, rules) {
  const pkgRules = rules[packageName];
  if (!pkgRules || pkgRules.length === 0) return null;

  if (typeof version !== "string" || !version) return null;

  // Coerce version, since package-lock versions should be concrete but
  // this makes us a bit more robust.
  const coerced = semver.coerce(version);
  if (!coerced) {
    // If coercion fails but there's a "*" rule, treat it as a match.
    const hasWildcard = pkgRules.some((r) => r.trim() === "*");
    return hasWildcard ? ["*"] : null;
  }

  const matchedRanges = pkgRules.filter((range) => {
    const trimmed = range.trim();
    if (trimmed === "*") {
      return true;
    }
    return semver.satisfies(coerced, trimmed, { includePrerelease: true });
  });

  return matchedRanges.length > 0 ? matchedRanges : null;
}

/**
 * Scan a parsed package-lock.json for bad packages.
 * Works for v1 and v2/v3 formats by walking the whole object.
 */
function scanPackageLock(json, file, rules) {
  const findings = [];

  function visit(node, pathSoFar) {
    if (!node || typeof node !== "object") return;

    // If this object itself describes a package: look for name + version
    if (node.name && node.version) {
      const matchedRanges = matchBadRules(node.name, node.version, rules);
      if (matchedRanges) {
        findings.push({
          file,
          location: pathSoFar || "<root>",
          name: node.name,
          version: node.version,
          matchedRanges,
        });
      }
    }

    // Handle dependencies-style maps:
    // "dependencies": { "pkg": { "version": "1.0.0", ... } }
    for (const [rawKey, value] of Object.entries(node)) {
      if (value && typeof value === "object") {
        const key = rawKey.replace(/^.*?((?:@[^\/]+\/)?[^\/]+)$/, "$1");
        // console.log(key, value);

        // If key is a package name in rules and value has a version field,
        // this is likely a dependency entry.
        if (rules[key] && value.version) {
          const matchedRanges = matchBadRules(key, value.version, rules);
          if (matchedRanges) {
            findings.push({
              file,
              location: pathSoFar ? `${pathSoFar}.${key}` : key,
              name: key,
              version: value.version,
              matchedRanges,
            });
          }
        }

        visit(value, pathSoFar ? `${pathSoFar}.${key}` : key);
      }
    }
  }

  visit(json, "");
  return findings;
}

run();
