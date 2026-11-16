import './globals.css';
import { Suspense } from 'react';
import ShellLayout from './components/shell-layout';

// Schibsted Grotesk is self-hosted from /public/fonts (globals.css @font-face): no network at build or run time.
export const metadata = {
  title: 'Orbit by Exora',
  description: 'Portfolio operations and analytics',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "'Schibsted Grotesk', 'Helvetica Neue', Arial, sans-serif" }}>
        <Suspense fallback={null}>
          <ShellLayout>{children}</ShellLayout>
        </Suspense>
      </body>
    </html>
  );
}
