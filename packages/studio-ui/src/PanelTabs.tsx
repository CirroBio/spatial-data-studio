import type { ReactNode } from 'react';
import * as Tabs from '@radix-ui/react-tabs';

export interface PanelTab<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  title?: string;
}

interface Props<T extends string> {
  tabs: PanelTab<T>[];
  // The active tab id — only needed to drive the collapse-to-icon layout; Radix
  // itself tracks selection via the enclosing Tabs.Root value.
  value: T;
  // Sidebar style: inactive triggers shrink to icon-only and the active one expands
  // to icon + label. Off (default) shows every label, splitting the width evenly.
  collapseInactive?: boolean;
  dataTour?: string;
}

/** The tab strip shared by the left sidebar and the canvas display-settings panel:
 * a Radix `Tabs.List` of triggers with the app's muted→text, accent-underline active
 * styling. Render inside a `<Tabs.Root value=… onValueChange=…>` alongside the
 * matching `<Tabs.Content>`s. Kept as just the list so each caller owns its Root and
 * content (their values/panels differ). */
export default function PanelTabs<T extends string>({ tabs, value, collapseInactive, dataTour }: Props<T>) {
  return (
    <Tabs.List data-tour={dataTour} className="flex items-stretch border-b border-border shrink-0">
      {tabs.map(({ id, label, icon, disabled, title }) => {
        const active = value === id;
        return (
          <Tabs.Trigger
            key={id}
            value={id}
            title={title ?? label}
            disabled={disabled}
            className={`flex items-center justify-center gap-1.5 py-2 min-w-0 text-muted data-[state=active]:text-text data-[state=active]:border-b-2 data-[state=active]:border-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors ${
              collapseInactive ? (active ? 'flex-1 px-2' : 'px-1.5') : 'flex-1 px-2'
            }`}
          >
            {icon && <span className="shrink-0">{icon}</span>}
            {(!collapseInactive || active) && <span className="text-[11px] font-medium truncate">{label}</span>}
          </Tabs.Trigger>
        );
      })}
    </Tabs.List>
  );
}
