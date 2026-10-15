"use client";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: 32, color: "#111827" }}>
        <h1>Something went wrong</h1>
        <p>RealtyPacer hit an unexpected error. {error.digest ? `Reference: ${error.digest}` : null}</p>
        <button type="button" onClick={reset} style={{ marginTop: 16, padding: "8px 16px" }}>
          Try again
        </button>
      </body>
    </html>
  );
}
