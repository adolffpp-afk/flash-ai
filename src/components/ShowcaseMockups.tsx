import type { ReactNode } from "react";
import type { ShowcaseExample } from "@/lib/showcase";

/*
 * The screenshots on the showcase's example cards: each drawn as the real thing would look (a
 * website in a browser window, an app on a phone, a dashboard), in light colours like a live page.
 * Decoration only, hidden from screen readers; the card's own text says what it is.
 */

// A browser window around a page, with its address.
function Browser({ url, children }: { url: string; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-[#000000]/10 bg-[#ffffff] text-[#18181b] shadow-[0_12px_30px_-18px_rgb(0_0_0/0.5)]">
      <div className="flex items-center gap-2 border-b border-[#000000]/[0.06] bg-[#f4f4f5] px-3 py-1.5">
        <span className="flex gap-1">
          <i className="h-2 w-2 rounded-full bg-[#ff5f57]" />
          <i className="h-2 w-2 rounded-full bg-[#febc2e]" />
          <i className="h-2 w-2 rounded-full bg-[#28c840]" />
        </span>
        <span className="mx-auto flex min-w-0 max-w-[75%] items-center gap-1 truncate rounded-md bg-[#ffffff] px-2 py-0.5 text-[9px] text-[#71717a]">
          <svg viewBox="0 0 16 16" className="h-2 w-2 shrink-0 fill-current">
            <path d="M4 7V5a4 4 0 1 1 8 0v2h1v8H3V7h1Zm2 0h4V5a2 2 0 1 0-4 0v2Z" />
          </svg>
          {url}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

function Booking() {
  return (
    <Browser url="elaia-hair.ca">
      <div className="relative h-20 overflow-hidden bg-[radial-gradient(circle_at_25%_40%,#f9d3c4,transparent_55%),radial-gradient(circle_at_80%_30%,#c9a28c,transparent_50%),linear-gradient(120deg,#5b3a2e,#a86f58)] px-3 py-2.5 text-[#ffffff]">
        <div className="text-[8px] uppercase tracking-[0.2em] opacity-80">Queen St W · Toronto</div>
        <div className="mt-1 font-serif text-[15px] leading-tight">Elaia Hair Studio</div>
        <div className="mt-1.5 inline-flex rounded-full bg-[#ffffff]/90 px-2 py-0.5 text-[8px] font-medium text-[#5b3a2e]">★ 4.9 · 312 reviews</div>
      </div>
      <div className="grid grid-cols-[1fr_88px] gap-2 p-2.5">
        <div className="space-y-1">
          {[
            ["Knotless braids", "2h 30m", "$180"],
            ["Cut & style", "45m", "$65"],
            ["Balayage", "3h", "$240"],
          ].map(([name, time, price], i) => (
            <div key={name} className={`flex items-center justify-between rounded-md border px-2 py-1 text-[9px] ${i === 0 ? "border-[#5b3a2e] bg-[#fbf3ef]" : "border-[#000000]/[0.08]"}`}>
              <span>
                <span className="font-medium">{name}</span> <span className="text-[#a1a1aa]">{time}</span>
              </span>
              <span className="font-medium">{price}</span>
            </div>
          ))}
        </div>
        <div className="rounded-md border border-[#000000]/[0.08] p-1.5 text-[8px]">
          <div className="font-medium">Sat, Oct 24</div>
          <div className="mt-1 grid grid-cols-2 gap-1">
            {["9:00", "10:30", "12:00", "2:15"].map((s, i) => (
              <span key={s} className={`rounded px-1 py-0.5 text-center ${i === 1 ? "bg-[#5b3a2e] text-[#ffffff]" : "bg-[#f4f4f5]"}`}>
                {s}
              </span>
            ))}
          </div>
          <div className="mt-1.5 rounded bg-[#18181b] py-0.5 text-center text-[#ffffff]">Book</div>
        </div>
      </div>
    </Browser>
  );
}

function Shop() {
  const items = [
    ["🥐", "Butter croissant", "$4.25", "from-[#fef3c7] to-[#fed7aa]"],
    ["🍞", "Country sourdough", "$9.00", "from-[#fef9c3] to-[#fde68a]"],
    ["🎂", "Strawberry cake", "$38.00", "from-[#ffe4e6] to-[#fbcfe8]"],
  ];
  return (
    <Browser url="goldencrumb.ca/shop">
      <div className="flex items-center justify-between border-b border-[#000000]/[0.06] px-3 py-1.5 text-[9px]">
        <span className="font-semibold tracking-tight">Golden Crumb</span>
        <span className="flex items-center gap-2 text-[#71717a]">
          Bread · Pastry · Cakes
          <span className="relative rounded-full bg-[#18181b] px-1.5 py-0.5 text-[#ffffff]">
            Cart <b className="ml-0.5 rounded-full bg-[#fbbf24] px-1 text-[#18181b]">3</b>
          </span>
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 p-2.5">
        {items.map(([emoji, name, price, bg]) => (
          <div key={name} className="overflow-hidden rounded-lg border border-[#000000]/[0.06]">
            <div className={`flex h-16 items-center justify-center bg-gradient-to-br ${bg} text-[34px] [filter:drop-shadow(0_6px_6px_rgb(0_0_0/0.18))]`}>{emoji}</div>
            <div className="p-1.5 text-[8px]">
              <div className="truncate font-medium">{name}</div>
              <div className="mt-0.5 flex items-center justify-between">
                <span className="text-[#71717a]">{price}</span>
                <span className="rounded bg-[#18181b] px-1 text-[#ffffff]">Add</span>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="mx-2.5 rounded-md bg-[#fffbeb] px-2 py-1 text-[8px] text-[#78350f]">Pickup today from 3 PM · Pay online with card</div>
    </Browser>
  );
}

function Phone() {
  const days = [40, 0, 65, 30, 0, 90, 55];
  return (
    <div className="flex h-full items-center justify-center bg-[radial-gradient(circle_at_50%_30%,#d1fae5,#ecfeff_60%)] py-2">
      <div className="relative h-full w-[8.5rem] rounded-[1.6rem] border-[5px] border-[#18181b] bg-[#ffffff] text-[#18181b] shadow-[0_14px_30px_-12px_rgb(0_0_0/0.45)]">
        <div className="absolute left-1/2 top-1 h-2.5 w-12 -translate-x-1/2 rounded-full bg-[#18181b]" />
        <div className="flex items-center justify-between px-3 pt-1 text-[7px] font-semibold">
          <span>9:41</span>
          <span className="flex items-center gap-0.5"><i className="h-1.5 w-2.5 rounded-[2px] border border-[#18181b]" /></span>
        </div>
        <div className="px-2.5 pt-2">
          <div className="text-[7px] text-[#71717a]">This week</div>
          <div className="text-[13px] font-bold leading-tight">18.4 km</div>
          <div className="mx-auto mt-1.5 grid h-14 w-14 place-items-center rounded-full bg-[conic-gradient(#10b981_0_74%,#e4e4e7_74%_100%)]">
            <div className="grid h-10 w-10 place-items-center rounded-full bg-[#ffffff] text-[8px] font-semibold">74%</div>
          </div>
          <div className="mt-1.5 flex h-8 items-end gap-[3px]">
            {days.map((h, i) => (
              <div key={i} className="flex-1 rounded-sm bg-[#10b981]/80" style={{ height: `${Math.max(h, 6)}%`, opacity: h ? 1 : 0.25 }} />
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[6px] text-[#a1a1aa]">
            {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
              <span key={i}>{d}</span>
            ))}
          </div>
          <div className="mt-1.5 rounded-lg bg-[#18181b] py-1 text-center text-[8px] font-medium text-[#ffffff]">Start run</div>
        </div>
      </div>
    </div>
  );
}

function CallCentre() {
  return (
    <Browser url="support.northwind.co/live">
      <div className="grid h-full grid-cols-[92px_1fr] text-[8px]">
        <div className="space-y-1 border-r border-[#000000]/[0.06] bg-[#fafafa] p-1.5">
          <div className="font-semibold text-[#71717a]">Agents</div>
          {[
            ["Amara", "bg-[#10b981]", "On call 4:12"],
            ["Luis", "bg-[#10b981]", "On call 1:03"],
            ["Mei", "bg-[#fbbf24]", "Wrap-up"],
            ["AI agent", "bg-[#0ea5e9]", "6 calls"],
          ].map(([name, dot, state]) => (
            <div key={name} className="flex items-center gap-1">
              <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
              <span className="font-medium">{name}</span>
              <span className="ml-auto truncate text-[7px] text-[#a1a1aa]">{state}</span>
            </div>
          ))}
          <div className="mt-2 rounded bg-[#ffffff] p-1 text-[7px] shadow-sm">
            <div className="text-[#71717a]">In queue</div>
            <div className="text-[13px] font-bold">2</div>
            <div className="text-[#a1a1aa]">avg wait 0:18</div>
          </div>
        </div>
        <div className="p-2">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 animate-pulse rounded-full bg-[#ef4444]" />
            <span className="font-semibold">+1 416 555 0148</span>
            <span className="text-[#a1a1aa]">· Order #2231 · 02:47</span>
          </div>
          <div className="mt-1.5 space-y-1">
            <p className="max-w-[85%] rounded-lg rounded-tl-sm bg-[#f4f4f5] px-1.5 py-1">My delivery was meant to come yesterday, where is it?</p>
            <p className="ml-auto max-w-[85%] rounded-lg rounded-tr-sm bg-[#0284c7] px-1.5 py-1 text-[#ffffff]">
              Sorry about that! It left our depot this morning and arrives today by 5 PM.
            </p>
          </div>
          <div className="mt-1.5 rounded-md border border-[#bae6fd] bg-[#f0f9ff] px-1.5 py-1 text-[#0c4a6e]">
            <b>AI suggests:</b> offer free delivery on the next order
          </div>
        </div>
      </div>
    </Browser>
  );
}

function Automation() {
  const steps = [
    ["🛍️", "New order in your shop", "Golden Crumb · order #1042", "bg-[#ede9fe]"],
    ["💬", "Send a text message", "“Thanks Sam! Your order is ready at 3 PM.”", "bg-[#d1fae5]"],
    ["📊", "Add a row to Google Sheets", "Orders 2026 · 7 columns", "bg-[#e0f2fe]"],
  ];
  return (
    <div className="h-full overflow-hidden rounded-xl border border-[#000000]/10 bg-[#fafafa] bg-[radial-gradient(#d4d4d8_1px,transparent_1px)] p-2.5 text-[#18181b] [background-size:12px_12px]">
      <div className="flex items-center justify-between text-[8px]">
        <span className="font-semibold">Order follow-up</span>
        <span className="flex items-center gap-1 rounded-full bg-[#d1fae5] px-1.5 py-0.5 text-[#065f46]">
          <i className="h-1.5 w-1.5 rounded-full bg-[#10b981]" /> On · ran 128 times
        </span>
      </div>
      <div className="mx-auto mt-1.5 w-[86%]">
        {steps.map(([icon, title, sub, bg], i) => (
          <div key={title}>
            {i > 0 && <div className="mx-auto h-2.5 w-px bg-[#a1a1aa]" />}
            <div className="flex items-center gap-2 rounded-lg border border-[#000000]/[0.08] bg-[#ffffff] px-2 py-1.5 shadow-sm">
              <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-md text-[12px] ${bg}`}>{icon}</span>
              <span className="min-w-0 text-[8px]">
                <span className="block font-semibold">{title}</span>
                <span className="block truncate text-[#71717a]">{sub}</span>
              </span>
              <span className="ml-auto text-[9px] text-[#059669]">✓</span>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1.5 text-center text-[7px] text-[#a1a1aa]">Last run 2 min ago · took 1.4 s</div>
    </div>
  );
}

function Dashboard() {
  const bars = [52, 61, 48, 70, 66, 82, 91, 77, 88, 95, 84, 100];
  return (
    <Browser url="kora-sales.flash-app.dev">
      <div className="p-2.5 text-[8px]">
        <div className="grid grid-cols-3 gap-1.5">
          {[
            ["Revenue", "$48,210", "+12.4%"],
            ["Orders", "1,284", "+8.1%"],
            ["Avg. order", "$37.55", "+3.9%"],
          ].map(([k, v, d]) => (
            <div key={k} className="rounded-md border border-[#000000]/[0.06] p-1.5">
              <div className="text-[#71717a]">{k}</div>
              <div className="text-[12px] font-bold leading-tight">{v}</div>
              <div className="text-[#059669]">{d}</div>
            </div>
          ))}
        </div>
        <div className="mt-2 flex h-16 items-end gap-1 border-b border-[#000000]/[0.08] pb-0.5">
          {bars.map((h, i) => (
            <div key={i} className="flex-1 rounded-t-sm bg-gradient-to-t from-[#6366f1] to-[#a78bfa]" style={{ height: `${h}%` }} />
          ))}
        </div>
        <div className="mt-1.5 grid grid-cols-3 gap-x-2 text-[#52525b]">
          {[
            ["Toronto", "$18.9k"],
            ["Montréal", "$12.4k"],
            ["Vancouver", "$9.7k"],
          ].map(([c, v]) => (
            <span key={c} className="flex justify-between">
              {c} <b className="text-[#18181b]">{v}</b>
            </span>
          ))}
        </div>
      </div>
    </Browser>
  );
}

const MOCKUPS: Record<ShowcaseExample["id"], () => ReactNode> = {
  booking: Booking,
  shop: Shop,
  phone: Phone,
  callcentre: CallCentre,
  automation: Automation,
  dashboard: Dashboard,
};

/** The screenshot for one example, filling its card's picture area. */
export function ShowcaseMockup({ id }: { id: ShowcaseExample["id"] }) {
  const Mockup = MOCKUPS[id];
  return (
    <div aria-hidden className="h-52 select-none">
      <Mockup />
    </div>
  );
}
