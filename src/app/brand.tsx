/*
 * The ⚡ logo drawn for generated images (the app icon and the social preview). It is drawn as
 * shapes rather than the emoji so the images don't need to download an emoji font.
 */
export const GRADIENT = "linear-gradient(135deg, #6366f1, #d946ef 50%, #ec4899)";

export function Bolt({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64">
      <path d="M36 8 14 36h15l-3 20 24-30H35z" fill="#facc15" stroke="#a16207" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
