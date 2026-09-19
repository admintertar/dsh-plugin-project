import type {ResourceView} from './project.ts';

/** Root bindings remain usable by task references; they are not managed resources. */
export function isProjectRootResource(item: ResourceView, root: string): boolean {
  const normalize = (path: string) => {
    const value = path.replace(/\\/g, '/').replace(/\/+$/, '');
    return /^[A-Za-z]:/.test(value) || value.startsWith('//') ? value.toLowerCase() : value;
  };
  return Boolean(item.path && normalize(item.path) === normalize(root));
}

export function managedResources<T extends ResourceView>(items: readonly T[], root: string): T[] {
  return items.filter(item => !isProjectRootResource(item, root));
}
