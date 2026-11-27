import type { TeammateLook } from "@/lib/ai/teammates";

/**
 * A teammate's drawn face (owner, 19 Nov 2026 — src/lib/ai/teammates.ts): a head and shoulders in a few shapes, or
 * Deskzo's spark for the team itself, as the inside of a 40×40 viewBox whose circle the caller draws. Pure and free of
 * "use client", so the dashboard's avatar and the public website draw the same face.
 */
export function TeammateFace({ look }: { look: TeammateLook }) {
  const { skin, hair, style } = look;
  if (style === "mark") {
    return (
      <g fill="#FFFFFF">
        <path d="M20 9.5 L22.6 17.4 L30.5 20 L22.6 22.6 L20 30.5 L17.4 22.6 L9.5 20 L17.4 17.4 Z" />
        <circle cx="29" cy="11" r="2.2" opacity=".85" />
      </g>
    );
  }
  return (
    <g>
      {/* shoulders */}
      <path d="M7 40 C8 31 13.5 28 20 28 C26.5 28 32 31 33 40 Z" fill="#FFFFFF" opacity=".92" />
      {/* hair behind, for long hair */}
      {style === "long" && <path d="M11.5 18 C11.5 9 28.5 9 28.5 18 L29.5 31 C26 29.5 14 29.5 10.5 31 Z" fill={hair} />}
      {/* neck and head */}
      <rect x="17.4" y="22" width="5.2" height="6.5" rx="2.4" fill={skin} />
      <ellipse cx="20" cy="17.5" rx="7" ry="7.8" fill={skin} />
      {/* hair on top */}
      {style === "short" && <path d="M12.8 16.2 C12.4 9.4 17 8 20.2 8 C24.6 8 27.9 10.3 27.2 16 C25.6 12.6 22.6 12 20 12 C17 12 14.4 13 12.8 16.2 Z" fill={hair} />}
      {style === "curly" && (
        <g fill={hair}>
          <circle cx="14.6" cy="12.6" r="3.2" />
          <circle cx="18.6" cy="10.2" r="3.4" />
          <circle cx="22.8" cy="10.4" r="3.3" />
          <circle cx="26" cy="13.2" r="3" />
          <circle cx="13.2" cy="16" r="2.2" />
          <circle cx="27" cy="16.4" r="2.1" />
        </g>
      )}
      {style === "long" && <path d="M12.6 17.6 C12.2 10.2 17 8.6 20 8.6 C23.4 8.6 28 10.4 27.4 17.4 C25 13.4 22.4 12.6 20 13.4 C17.4 12.6 14.6 13.8 12.6 17.6 Z" fill={hair} />}
      {style === "bun" && (
        <g fill={hair}>
          <circle cx="20" cy="7.4" r="3.6" />
          <path d="M12.8 16.8 C12.4 10.6 16.6 9.2 20 9.2 C23.4 9.2 27.6 10.6 27.2 16.8 C25.6 13.2 22.8 12.4 20 12.4 C17.2 12.4 14.4 13.2 12.8 16.8 Z" />
        </g>
      )}
      {/* a calm face: two eyes and a small smile */}
      <circle cx="17.4" cy="18.2" r=".9" fill="#1F2937" />
      <circle cx="22.6" cy="18.2" r=".9" fill="#1F2937" />
      <path d="M17.8 21.6 C19 22.8 21 22.8 22.2 21.6" stroke="#1F2937" strokeWidth=".9" fill="none" strokeLinecap="round" />
    </g>
  );
}
