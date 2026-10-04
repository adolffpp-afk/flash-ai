import { ImageResponse } from "next/og";
import { BrandMark, GRADIENT } from "../../brand";

// The installed-app icons. "maskable" keeps the mark inside the middle 80%, because Android crops
// app icons to its own shape (circle, squircle and so on).
const ICONS = { "192": { size: 192, mark: 170 }, "512": { size: 512, mark: 456 }, maskable: { size: 512, mark: 340 } };

export const dynamic = "force-static";
export const generateStaticParams = () => Object.keys(ICONS).map((name) => ({ name }));

export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const icon = ICONS[name as keyof typeof ICONS];
  if (!icon) return new Response("Not found", { status: 404 });
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: GRADIENT }}>
        <BrandMark size={icon.mark} />
      </div>
    ),
    { width: icon.size, height: icon.size },
  );
}
