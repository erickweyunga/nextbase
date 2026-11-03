import type { Collection } from '@nextbasejs/client';
import type { ReactNode } from 'react';
import { FolderIcon, GroupIcon, TableIcon } from './ui/icons/index.tsx';

export function typeIcon(type: Collection['type'], size = 20): ReactNode {
  if (type === 'auth') return <GroupIcon size={size} />;
  if (type === 'view') return <TableIcon size={size} />;
  return <FolderIcon size={size} />;
}
