import { useEffect, useState } from 'react';

const ROOT: React.CSSProperties = {
  background:    'var(--surface)',
  border:        '1px solid var(--line-strong)',
  borderRadius:  'var(--card-radius)',
  color:         'var(--ink-2)',
  fontFamily:    'var(--font-mono)',
  fontSize:      12,
  fontWeight:    700,
  padding:       '4px 8px',
  pointerEvents: 'none',
  boxShadow:     'var(--shadow-sm)',
  letterSpacing: '0.04em',
};

export function FpsCounter() {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    let frames = 0;
    let last = performance.now();
    let raf = 0;
    const tick = () => {
      frames++;
      const now = performance.now();
      const dt  = now - last;
      if (dt >= 500) {
        setFps(Math.round((frames * 1000) / dt));
        frames = 0;
        last   = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <div style={ROOT} aria-label="Frames per second">{fps} FPS</div>;
}
