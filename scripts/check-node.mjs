import {readFileSync} from 'node:fs';

// Keep this guard dependency-free so it can reject an unsupported runtime
// before TypeScript loaders, filesystem watchers or application code start.
const {engines: {node: required}} = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** Parse stable Node releases only; prereleases do not satisfy our engines. */
function versionParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? match.slice(1).map(Number) : undefined;
}

/** Compare the release tuple without relying on lexicographic version order. */
function atLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index++) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

// Support the explicit positive-major caret/lower-bound alternatives used by
// this repository. A future engines syntax change must update this guard too.
const ranges = required.split('||').map(range => {
  const match = /^(\^|>=)([1-9]\d*\.\d+\.\d+)$/.exec(range.trim());
  if (!match) throw new Error(`Unsupported Node engines expression: ${required}`);
  return {operator: match[1], minimum: versionParts(match[2])};
});
const actual = versionParts(process.versions.node);
if (!actual || !ranges.some(({operator, minimum}) => atLeast(actual, minimum)
  && (operator !== '^' || actual[0] === minimum[0]))) {
  console.error(`dsh-plugin-project requires Node.js ${required}; current version: ${process.versions.node}. Switch to a supported version (for nvm, run "nvm use") and retry.`);
  process.exitCode = 1;
}
