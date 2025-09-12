import './globals.css';
import ClientProviders from '../components/ClientProviders';
import ErrorBoundary from '../components/ErrorBoundary';

export const metadata = {
  title: 'MCP Projects UI',
  description: 'Manage MCP agent projects'
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <ClientProviders>
          <ErrorBoundary>
            {children}
          </ErrorBoundary>
        </ClientProviders>
      </body>
    </html>
  );
}
