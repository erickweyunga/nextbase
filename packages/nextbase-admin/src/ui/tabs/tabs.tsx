import { Tabs as BaseTabs } from 'baseui/tabs-motion';
import { useId } from 'react';
import type { PropsOf } from '../props-of';

export type TabsProps = PropsOf<typeof BaseTabs>;

/** baseui's Tabs, with ids from useId: baseui's react-uid counter differs between server and client. */
export function Tabs({ uid, ...props }: TabsProps) {
  const generatedUid = useId();
  return <BaseTabs uid={uid ?? generatedUid} {...props} />;
}
