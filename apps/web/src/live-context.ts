/** The open notebook's live connection, shared by every page inside it. */
import { createContext, useContext } from 'react';
import type { Live } from './api';

export const LiveContext = createContext<Live | undefined>(undefined);

export function useLive(): Live {
  const live = useContext(LiveContext);
  if (!live) throw new Error('useLive is for pages inside an open notebook.');
  return live;
}
