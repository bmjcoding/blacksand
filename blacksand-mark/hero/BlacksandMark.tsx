'use client';
// React / Next.js wrapper for the animated blacksand mark.
// Put blacksand-engine.js and blacksand-hero.js next to this file.
import { useEffect, useRef } from 'react';
import { mountBlacksand } from './blacksand-hero.js';

type Props = {
  /** CSS px width of the mark's 1024-unit box. Defaults to min(420, 34% of width, 50% of height). */
  markSize?: number;
  /** Let a fine pointer (mouse) over the canvas lean the hidden light toward it. Off by default. */
  pointerLight?: boolean;
  className?: string;
  style?: React.CSSProperties;
};

export default function BlacksandMark({ markSize, pointerLight = false, className, style }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const hero = mountBlacksand(ref.current, { markSize, pointerLight });
    return () => hero.destroy();
  }, [markSize, pointerLight]);
  // The canvas fills its box; give the parent a height and a #000 background.
  return <canvas ref={ref} aria-label="blacksand" role="img" className={className} style={{ display: 'block', width: '100%', height: '100%', ...style }} />;
}
