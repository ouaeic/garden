/*
 * Key symbols the screen's pixel font has no glyph for, drawn on its own grid instead, so they
 * stand on the same line and at the same height as the letters beside them rather than borrowing a
 * system font that sits higher and smaller.
 */
const glyphs = {
  mod: ['33...33', '3.3.3.3', '.33333.', '..3.3..', '.33333.', '3.3.3.3', '33...33'],
  enter: ['......3', '......3', '..3...3', '.33...3', '3333333', '.33....', '..3....']
} as const;
const names = { mod: 'Command', enter: 'Return' } as const;

const isMac = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/** A shortcut as keys, where `mod` is Command on a Mac and Ctrl everywhere else. */
export function Keys({ keys }: { keys: readonly string[] }) {
  return (
    <kbd className="keys">
      {keys.map((key, index) => {
        if (key === 'mod' && !isMac()) return <span key={index}>Ctrl</span>;
        if (key !== 'mod' && key !== 'enter') return <span key={index}>{key}</span>;
        const rows = glyphs[key];
        return (
          <svg
            key={index}
            role="img"
            aria-label={names[key]}
            viewBox="0 0 7 7"
            shapeRendering="crispEdges"
          >
            {rows.flatMap((row, y) =>
              [...row].map((cell, x) =>
                cell === '3' ? <rect key={`${x},${y}`} x={x} y={y} width={1} height={1} /> : null
              )
            )}
          </svg>
        );
      })}
    </kbd>
  );
}
