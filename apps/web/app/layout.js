import './globals.css';

// DM Sans loads in the browser; next/font/google failed to fetch it during the Docker build.
export const metadata = {
  title: 'PortfolioOS',
  description: 'Daily view of the Sona portfolio',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap"
        />
      </head>
      <body style={{ fontFamily: "'DM Sans', system-ui, -apple-system, sans-serif" }}>{children}</body>
    </html>
  );
}
