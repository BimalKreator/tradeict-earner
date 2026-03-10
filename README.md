# Tradeict Earner

Full-stack Next.js app (App Router) with Tailwind CSS and TypeScript. Works as both a web app and an installable PWA.

## Stack

- **Next.js 14** (App Router)
- **TypeScript**
- **Tailwind CSS**
- **PWA**: manifest, service worker, mobile-friendly viewport and theme

## Theme

Dark blue glass (glassmorphism) with dark blue accents. See `app/globals.css` for CSS variables and `tailwind.config.ts` for theme extensions.

## Folder structure

```
├── app/                 # App Router (layout, page, globals)
├── components/          # Reusable UI components
├── lib/                 # Utilities and shared logic
├── public/              # Static assets, manifest, sw.js, icons
└── ...
```

## Setup

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## PWA

- Add `public/icons/icon-192.png` and `public/icons/icon-512.png` for install icons.
- Manifest: `public/manifest.json`
- Service worker: `public/sw.js` (registered client-side from `app/sw-register.tsx`).

## Build

```bash
npm run build
npm start
```

No trading logic is implemented yet.
