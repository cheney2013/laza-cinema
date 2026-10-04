'use client';

import { useId } from 'react';

/**
 * The LAZA CINEMA STUDIO mark: a cat head drawn as one smooth outline (cheek straight up to the ear tip),
 * with a play triangle cut out of it. One flat colour, no gradient. The same geometry as
 * public/laza-mark.svg.
 */
export function LazaMark({ size = 24, className }: { size?: number; className?: string }) {
  const mask = `laza-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <svg width={size} height={size} viewBox="0 0 128 128" className={className} role="img" aria-label="LAZA CINEMA STUDIO">
      <defs>
        <mask id={mask}>
          <rect width="128" height="128" fill="#fff" />
          <path d="M57.17 60.57L57.17 89.43L82.17 75.00Z" fill="#000" stroke="#000" strokeWidth="3" strokeLinejoin="round" />
        </mask>
      </defs>
      <g mask={`url(#${mask})`}>
        <path d="M73.00 35.00L101.00 10.00C107.00 26.00 111.00 48.00 111.00 68.00C111.00 94.00 92.00 108.00 64 108.0C36.00 108.00 17.00 94.00 17.00 68.00C17.00 48.00 21.00 26.00 27.00 10.00L55.00 35.00Q64 42.0 73.00 35.00Z" fill="#F4A340" stroke="#F4A340" strokeWidth="4.0" strokeLinejoin="round" />
      </g>
    </svg>
  );
}
