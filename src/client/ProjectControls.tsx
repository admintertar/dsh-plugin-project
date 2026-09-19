import {useEffect, useId, useRef, useState, type ComponentProps, type ReactNode} from 'react';
import {Button, DisclosureRow, IconChevronDownOutline14, IconChevronRightOutline14, IconPlusOutline16, Menu, Modal, Switch} from '@deepseek-ai/dsh-client-ui-primitives';

interface SelectOption<T extends string> {value: T; label: string}
type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

/** SettingsRoot.options modal structure: fixed chrome, with the official 24px insets owned by one scrolling body. */
export function ProjectScrollableModal(props: DistributiveOmit<ComponentProps<typeof Modal>, 'className' | 'contentClassName'>) {
  return <Modal {...props} className="project-settings-dialog" contentClassName="project-settings-dialog-content" />;
}

/** LanguageRow setting-cell layout; long editors use the official full-width pattern. */
export function ProjectSettingRow({title, description, htmlFor, layout = 'control', children}: {
  title: string; description?: string; htmlFor?: string; layout?: 'control' | 'input' | 'stacked'; children: ReactNode;
}) {
  return <div className={`project-setting-row project-setting-row-${layout}`}>
    <div className="project-setting-copy">
      {htmlFor ? <label className="project-setting-title" htmlFor={htmlFor}>{title}</label> : <span className="project-setting-title">{title}</span>}
      {description && <p className="project-setting-description" id={htmlFor ? `${htmlFor}-description` : undefined}>{description}</p>}
    </div>
    <div className="project-setting-control">{children}</div>
  </div>;
}

/** DesktopSettingsSection.ToggleRow is private; retain shared Switch behavior with its desktop appearance. */
export function ProjectSwitch(props: Omit<ComponentProps<typeof Switch>, 'className'>) {
  return <Switch {...props} className="project-desktop-switch" />;
}

/** Use the ordinary setting row with Desktop's notification switch appearance. */
export function ProjectToggleRow({label, ...props}: Omit<ComponentProps<typeof ProjectSwitch>, 'title'>) {
  return <ProjectSettingRow title={label}><ProjectSwitch {...props} label={label} /></ProjectSettingRow>;
}

/** Adapt the private ui-settings-plugins/PluginCard chrome used by Subagent; the enclosing form owns saving. */
export function ProjectSettingsCard({title, description, children, disabled = false}: {
  title: string; description: string; children: ReactNode; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <section className="project-settings-card" data-open={open} aria-labelledby={`${id}-title`}>
    <Button className="project-settings-card-header" disabled={disabled} aria-expanded={open} aria-controls={`${id}-body`}
      aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onClick={() => setOpen(value => !value)}>
      <span className="project-settings-card-copy">
        <span className="project-settings-card-title" id={`${id}-title`}>{title}</span>
        <span className="project-settings-card-description" id={`${id}-description`}>{description}</span>
      </span>
      <IconChevronDownOutline14 className="project-settings-card-chevron" />
    </Button>
    {/* Keep fields mounted so collapsing retains draft values and native validation. */}
    <div className="project-settings-card-body" id={`${id}-body`} hidden={!open}>{children}</div>
  </section>;
}

/** Match the official LanguageRow selector with shared Button, Menu and chevron. */
export function ProjectSelect<T extends string>({label, value, options, onChange, disabled = false}: {
  label: string; value: T; options: readonly SelectOption<T>[]; onChange(value: T): void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [menuReady, setMenuReady] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const selected = options.find(option => option.value === value);
  const focusTrigger = () => root.current?.querySelector<HTMLButtonElement>('button')?.focus();
  useEffect(() => {if (disabled) setOpen(false);}, [disabled]);
  useEffect(() => {
    if (!open || disabled) {setMenuReady(false); return;}
    // The pinned Menu first measures a hidden portal; focus after it is placed.
    const frame = requestAnimationFrame(() => setMenuReady(true));
    return () => cancelAnimationFrame(frame);
  }, [open, disabled]);
  return <span ref={root} className="project-select" onKeyDown={event => {
    // Menu is portaled; consume its Escape before the containing Modal sees it.
    if (event.key === 'Escape' && open) {event.preventDefault(); event.stopPropagation(); setOpen(false); focusTrigger();}
  }}>
    <Menu open={open && !disabled} portal autoFocus={menuReady} selectedId={value}
      items={options.map(option => ({id: option.value, label: option.label}))}
      onClose={() => setOpen(false)} onSelect={id => {
        const option = options.find(item => item.value === id);
        if (option && !disabled) onChange(option.value);
        setOpen(false); focusTrigger();
      }}
      anchor={<Button className="project-select-trigger" disabled={disabled}
        aria-label={`${label}: ${selected?.label ?? value}`} aria-haspopup="menu" aria-expanded={open && !disabled}
        onClick={() => setOpen(current => !current)}
        onKeyDown={event => {if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {event.preventDefault(); setOpen(true);}}}>
        <span>{selected?.label ?? value}</span><IconChevronDownOutline14 />
      </Button>} />
  </span>;
}

/** Official ModelsSection add-provider affordance, using the shared Button and plus icon. */
export function ProjectAddButton({children, ...props}: Omit<ComponentProps<typeof Button>, 'className' | 'variant' | 'size' | 'icon'>) {
  return <Button {...props} variant="outline" className="project-add-button" icon={<IconPlusOutline16 size={14} />}>{children}</Button>;
}

/** Keep collapsed form fields mounted while the official DisclosureRow owns the toggle. */
export function ProjectDisclosure({title, children, disabled = false}: {title: string; children: ReactNode; disabled?: boolean}) {
  const [open, setOpen] = useState(false);
  return <div className="project-disclosure">
    <DisclosureRow title={title} icon={<IconChevronRightOutline14 />} open={open} expandable={!disabled}
      expandOnRowClick previewChevron={false} onToggle={() => setOpen(value => !value)} />
    <div className="project-disclosure-content" hidden={!open}>{children}</div>
  </div>;
}
