import './globals.css';

export const metadata = {
  title: 'DMATICS Cyber Arcade — GISEC 2026',
  description:
    'Three 60-second cybersecurity games — Phish Hunter, Alert Rush, Breach Point — by DMATICS IT Solutions. Beat the leaderboard and review your answers.',
  applicationName: 'DMATICS Cyber Arcade',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Cyber Arcade' },
  icons: { icon: '/favicon.svg' },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#0a0713',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
