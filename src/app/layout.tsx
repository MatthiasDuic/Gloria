import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Gloria – KI-Vertriebsassistentin",
  description:
    "Admin-Dashboard für B2B-Neukundenakquise, Skripte, Reports, CSV-Kampagnen und Outlook-Export.",
  icons: {
    icon: "/Gloria.png",
    apple: "/Gloria.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de">
      <body>{children}</body>
    </html>
  );
}
