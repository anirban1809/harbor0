import type { ReactNode } from 'react';
import { Tab, TabList, TabPanel, Tabs } from './ui/tabs';

export type SharedTab = 'Received' | 'Sent' | 'Links';

export function SharedTabs({
  tab,
  tabs = ['Received', 'Sent'],
  onChange,
  children,
}: {
  tab: SharedTab;
  /** Links is shown only to accounts with public links. */
  tabs?: SharedTab[];
  onChange: (tab: SharedTab) => void;
  children: ReactNode;
}) {
  return (
    <Tabs className="shared-page" value={tab} onValueChange={onChange}>
      <TabList className="shared-tabs" aria-label="Shared views">
        {tabs.map((name) => (
          <Tab key={name} value={name} id={`shared-tab-${name}`}>
            {name}
          </Tab>
        ))}
      </TabList>
      <TabPanel value={tab} id="shared-content" className="page-stack">
        {children}
      </TabPanel>
    </Tabs>
  );
}
