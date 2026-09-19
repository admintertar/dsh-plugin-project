import {useEffect, useSyncExternalStore} from 'react';
import type {PropsLocale} from '@deepseek-ai/dsh-client-ui-slots';
import type {ProjectCapabilityController} from './controller.ts';
import type {CapabilityView, CapabilityContext} from './types.ts';
export type CapabilityTranslate = PropsLocale<'project'>['t'];
export function useCapability<K extends CapabilityView>(controller: ProjectCapabilityController, view: K) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    void controller.refresh(view);
    const timer = setInterval(() => {if (!document.hidden) void controller.refresh(view);}, 5000);
    return () => clearInterval(timer);
  }, [controller, view]);
  return snapshot[view];
}
export function CapabilityError({error, t}: {error?: string; t: CapabilityTranslate}) {
  if (!error) return null;
  return <p role="alert" className="project-error">{t(error === 'unauthorized' ? 'authenticationError'
    : error === 'body-too-large' ? 'bodyTooLarge' : error === 'native-picker-unavailable' ? 'nativePickerUnavailable'
      : error === 'catalog-unavailable' ? 'catalogUnavailable' : error === 'project-session-unavailable' ? 'catalogSessionUnavailable' : 'capabilityError')}</p>;
}
export function CatalogContext({context, t}: {context?: CapabilityContext; t: CapabilityTranslate}) {
  if (context?.kind !== 'project') return null;
  return <p className="project-catalog-context">{t('catalogNoSession')}</p>;
}
