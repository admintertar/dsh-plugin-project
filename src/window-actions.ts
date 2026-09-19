import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-client-connection';
import {ProjectHttpError, requireAuthenticatedRequest, readJsonBody, sendJson, sendProjectError} from './http.ts';

interface Windows {
  list(): Promise<readonly {id: string; title: string; current: boolean}[]>;
  open(): Promise<void>;
  focus(id: string): Promise<void>;
  presentation?(): Promise<string>;
  selectPresentation?(mode: string, directory?: string): Promise<void>;
}

/** Optional Desktop capability; the Web plugin remains a regular DSH plugin. */
export function registerWindowActions(ctx: Context): void {
  const windows = (ctx.get('desktopRuntime') as {workspaceWindows?: Windows} | undefined)?.workspaceWindows;
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/api/project/windows',
    async handler(req, res) {
      try {
        requireAuthenticatedRequest(ctx, req, ['GET', 'POST']);
        if (req.method === 'GET') {sendJson(res, {enabled: Boolean(windows), windows: await windows?.list() ?? [], ...(windows?.presentation ? {presentation: await windows.presentation()} : {})}); return;}
        if (!windows) throw new ProjectHttpError(409, 'windows-unavailable');
        const action = await readJsonBody(req, 4096);
        if (!action || typeof action !== 'object' || !('action' in action)) throw new Error('无效的窗口操作');
        if (action.action === 'presentation' && 'mode' in action && typeof action.mode === 'string'
          && ['project', 'advanced', 'extended', 'compatibility'].includes(action.mode)) {
          const directory = 'directory' in action ? action.directory : undefined;
          if (directory !== undefined && typeof directory !== 'string') throw new Error('无效的工作区目录');
          if (!windows.selectPresentation) throw new Error('当前桌面不支持切换项目模式');
          await windows.selectPresentation(action.mode, directory);
        }
        else if (action.action === 'open') await windows.open();
        else if (action.action === 'focus' && 'id' in action && typeof action.id === 'string') await windows.focus(action.id);
        else throw new Error('无效的窗口操作');
        sendJson(res, {ok: true});
      } catch (error) {sendProjectError(res, error, ['GET', 'POST']);}
    },
  }), 'project: native window actions');
}
