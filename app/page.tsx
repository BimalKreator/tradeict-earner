export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-6 md:p-8">
      <div className="w-full max-w-lg space-y-8">
        {/* Hero card with glass effect */}
        <div className="glass-panel p-8 md:p-10 text-center space-y-4">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-white">
            Tradeict Earner
          </h1>
          <p className="text-slate-400 text-sm md:text-base max-w-sm mx-auto">
            Web & mobile PWA. Dark blue glass theme — ready for the next steps.
          </p>
        </div>

        {/* Secondary glass block */}
        <div className="glass-panel-strong p-6 flex flex-col gap-4">
          <h2 className="text-lg font-semibold text-slate-200">Getting started</h2>
          <p className="text-slate-400 text-sm">
            This is a Next.js App Router app with Tailwind CSS and TypeScript.
            It works as both a website and an installable PWA.
          </p>
          <div className="flex flex-wrap gap-3 justify-center pt-2">
            <a
              href="#"
              className="glass-button px-5 py-2.5 rounded-xl text-sm font-medium text-slate-200 accent-border"
            >
              Learn more
            </a>
          </div>
        </div>
      </div>
    </main>
  );
}
