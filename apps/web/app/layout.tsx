import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Shell } from '@/components/Shell';
import './globals.css';

export const metadata: Metadata = { title: 'AI Work Hub', description: 'One intelligent workspace across mail, chat, code, tickets and meetings' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body><Shell>{children}</Shell></body></html>;
}
