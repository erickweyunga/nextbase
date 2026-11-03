import { type ReactNode, useState } from 'react';
import { Client } from 'styletron-engine-monolithic';
import { Provider as StyletronProvider } from 'styletron-react';

export function StyletronRegistry({ children }: { children: ReactNode }) {
  const [engine] = useState(() => new Client());
  return <StyletronProvider value={engine}>{children}</StyletronProvider>;
}
