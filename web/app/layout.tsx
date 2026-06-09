import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'API AI Agent',
  description: 'An intelligent AI agent that connects to custom APIs and integrates with GitHub.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-gray-100 min-h-screen antialiased">{children}</body>
    </html>
  );
}
