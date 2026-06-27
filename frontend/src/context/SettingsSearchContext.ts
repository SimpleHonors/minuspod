import { createContext, useContext } from 'react';

// The set of CollapsibleSection storage-keys whose title or settings match the
// active settings search, or null when no search is active. Provided only
// around the Settings page's configurable sections; CollapsibleSection reads it
// to self-filter (hide non-matches, force-expand matches). Everywhere else the
// default null leaves CollapsibleSection behaving normally.
export const SettingsSearchContext = createContext<Set<string> | null>(null);

export function useSettingsSearch(): Set<string> | null {
  return useContext(SettingsSearchContext);
}
