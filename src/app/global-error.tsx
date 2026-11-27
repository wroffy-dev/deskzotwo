"use client";

import "./globals.css";
import { PageError } from "@/components/layout/page-error";

/**
 * The root layout itself failed — most often the database not answering, since the layout reads the
 * workspace's branding before anything else. Next then draws this instead of the whole document, so
 * it brings its own <html> and <body> and the app's styles; the workspace's colour and theme are not
 * known here, so it takes the defaults in globals.css. Without it, an outage showed Next's bare
 * "Application error" text.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col bg-bg text-text">
        <title>Something went wrong</title>
        <main className="w-full px-4 py-6">
          <PageError error={error} retry={retry} back={{ href: "/", label: "the home page" }} />
        </main>
      </body>
    </html>
  );
}
