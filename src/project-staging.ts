import {parse, stringify} from 'yaml';
import type {StagedProjectFile} from './resource-sync.ts';

const SKILL_INDEX = 'skills/index.yaml';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Parse a document, treating empty or malformed text as absent. */
function parseDocument(text: string | undefined): unknown {
  if (text === undefined || text.trim() === '') return undefined;
  try {return parse(text);} catch {return undefined;}
}

/**
 * The Skill a `skill:<name>` asset owns. The fallback `index.yaml` asset owns the whole file rather
 * than a Skill, so it has no name to rebuild the index from and is staged by path instead.
 */
export function assetSkillName(id: string): string | undefined {
  if (!id.startsWith('skill:')) return undefined;
  const name = id.slice('skill:'.length);
  return name === 'index.yaml' ? undefined : name;
}

/**
 * The exact bytes the Skill index must have after committing only `name`: the other Skills keep the
 * enabled state they have in HEAD. Staged by content because one index file carries every Skill, and
 * the worktree is never rewritten, so the rest of the review stays intact.
 */
export function stageSkillIndex(head: string | undefined, working: string | undefined, name: string): StagedProjectFile {
  const headDocument = parseDocument(head);
  const skills = isRecord(headDocument) && isRecord(headDocument.skills) ? {...headDocument.skills} : {};
  const workingDocument = parseDocument(working);
  const state = isRecord(workingDocument) && isRecord(workingDocument.skills) ? workingDocument.skills[name] : undefined;
  if (state === undefined) delete skills[name];
  else skills[name] = state;
  return {path: SKILL_INDEX, content: stringify({schemaVersion: 1, skills}, {lineWidth: 0})};
}
