import type {Context} from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent-presets';
import type {} from '@deepseek-ai/dsh-session-query';
import type {SessionId} from '@deepseek-ai/dsh-session';
import type {ScopeKey} from '@deepseek-ai/dsh-scope';
import type {CapabilityContext} from './api-types.ts';
import {ProjectHttpError} from './http.ts';

/** Resolve the official live/standing composition without activating an Agent. */
export async function sessionCapabilities(ctx: Context, root: string, url: string | undefined) {
  const params = new URL(url ?? '/', 'http://localhost').searchParams;
  const sessionId = params.get('sessionId');
  if (sessionId === null) return {context: {kind: 'project'} as CapabilityContext, scope: undefined,
    skills: ctx.skills, tools: ctx.tools};
  // DSH Session IDs are opaque strings. Keep the decoded value unchanged;
  // the official reader resolves identity and the header check enforces ownership.
  if (params.getAll('sessionId').length !== 1 || sessionId.length === 0) {
    throw new ProjectHttpError(422, 'invalid-session');
  }
  const query = ctx.get('sessionQuery');
  if (!query) throw new ProjectHttpError(503, 'catalog-unavailable');
  let agentPreset: string | undefined;
  try {
    using observation = await query.observeSession(sessionId as SessionId);
    // The observation covers persisted as well as live Sessions. Never mount a
    // foreign preset or expose its catalogs before checking the Project root.
    if (observation.header.cwd !== root) throw new ProjectHttpError(404, 'project-session-unavailable');
    if (!observation.projections) throw new ProjectHttpError(503, 'catalog-unavailable');
    agentPreset = observation.projections.values.agentPreset ?? undefined;
  } catch (error) {
    if (error instanceof ProjectHttpError) throw error;
    if (error && typeof error === 'object' && 'code' in error && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
      throw new ProjectHttpError(404, 'project-session-unavailable');
    }
    throw new ProjectHttpError(503, 'catalog-unavailable');
  }
  const live = ctx.get('agents')?.get(sessionId as SessionId);
  const presets = ctx.get('agentPresets');
  let scope: ScopeKey | undefined = live;
  if (!live && presets) {
    try {scope = await presets.standingKeyFor(agentPreset);}
    catch {throw new ProjectHttpError(503, 'catalog-unavailable');}
  }
  // A missing recorded preset must not silently become the global catalog.
  if (!live && !presets && agentPreset) throw new ProjectHttpError(503, 'catalog-unavailable');
  return {
    context: {kind: 'session', sessionId, agentPreset: agentPreset ?? presets?.defaultId} as CapabilityContext,
    scope,
    skills: (live ? presets?.serviceFor(live, 'skills') : undefined) ?? ctx.skills,
    tools: (live ? presets?.serviceFor(live, 'tools') : undefined) ?? ctx.tools,
  };
}
